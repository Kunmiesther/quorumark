/*
 * Owner-only publication worker.
 *
 * This process is intentionally separate from browser code. It requires a
 * dedicated server secret (NEAR_OWNER_PRIVATE_KEY) and a server-only
 * Supabase key. Without both, it exits instead of creating a misleading
 * verification result.
 */
import { connect, keyStores, KeyPair } from "near-api-js";

const required = [
  "QUORUMARK_SUPABASE_URL",
  "QUORUMARK_SUPABASE_SECRET_KEY",
  "QUORUMARK_NEAR_EVIDENCE_CONTRACT_ID",
  "QUORUMARK_NEAR_EVIDENCE_OWNER_ID",
  "NEAR_OWNER_PRIVATE_KEY",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error("Publication worker is disabled: required server configuration is missing", missing.join(", "));
  process.exitCode = 1;
  process.exit();
}

const supabaseUrl = process.env.QUORUMARK_SUPABASE_URL.replace(/\/$/, "");
const supabaseKey = process.env.QUORUMARK_SUPABASE_SECRET_KEY;
const ownerId = process.env.QUORUMARK_NEAR_EVIDENCE_OWNER_ID;
const contractId = process.env.QUORUMARK_NEAR_EVIDENCE_CONTRACT_ID;
const rpcUrl = process.env.VITE_NEAR_RPC_URL || "https://rpc.testnet.near.org";
const maxAttempts = 5;
const pollMs = 15_000;

async function db(path, init = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Supabase request failed with HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function claimJob() {
  const jobs = await db("strategy_exchange_publication_jobs", {
    method: "GET",
    headers: { Prefer: "return=representation" },
    // PostgREST filters keep the worker from claiming completed jobs.
  });
  const now = Date.now();
  const job = jobs.find((item) =>
    (item.status === "pending" || item.status === "failed") &&
    item.attempts < maxAttempts && new Date(item.next_attempt_at).getTime() <= now,
  );
  if (!job) return null;
  const nextAttempt = job.attempts + 1;
  const updated = await db(`strategy_exchange_publication_jobs?id=eq.${job.id}&status=eq.${job.status}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "processing", attempts: nextAttempt, locked_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  return updated?.[0] || null;
}

async function processJob(job, account) {
  const result = await account.functionCall({
    contractId,
    methodName: "record_publication",
    args: { commitment: job.commitment, strategy_id: job.strategy_id, version_id: job.version_id },
    gas: "30000000000000",
    attachedDeposit: "0",
  });
  const txHash = result?.transaction?.hash;
  if (!txHash) throw new Error("NEAR did not return a transaction hash");
  const publication = await account.viewFunction({
    contractId,
    methodName: "get_publication",
    args: { strategy_id: job.strategy_id, version_id: job.version_id },
  });
  if (!publication || publication.commitment !== job.commitment || publication.strategy_id !== job.strategy_id || publication.version_id !== job.version_id) {
    throw new Error("NEAR readback did not match the queued commitment");
  }
  const confirmedAt = new Date().toISOString();
  await db(`strategy_exchange_publication_evidence?version_id=eq.${job.version_id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "confirmed", transaction_hash: txHash, transaction_receiver: contractId, receipt: result, confirmed_at: confirmedAt }),
  });
  await db(`strategy_exchange_publication_jobs?id=eq.${job.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "confirmed", transaction_hash: txHash, updated_at: confirmedAt, locked_at: null }),
  });
  console.log("Publication verified", { version_id: job.version_id, transaction_hash: txHash, contract: contractId });
}

async function failJob(job, error) {
  const attempts = Number(job.attempts || 0);
  const terminal = attempts >= maxAttempts;
  const nextAttemptAt = new Date(Date.now() + Math.min(15 * 2 ** attempts, 15 * 60) * 1000).toISOString();
  const message = error instanceof Error ? error.message.slice(0, 300) : "Unknown publication error";
  await db(`strategy_exchange_publication_jobs?id=eq.${job.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: terminal ? "failed" : "pending", last_error: message, next_attempt_at: nextAttemptAt, locked_at: null, updated_at: new Date().toISOString() }),
  });
  await db(`strategy_exchange_publication_evidence?version_id=eq.${job.version_id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: terminal ? "failed" : "pending" }),
  });
  console.error("Publication attempt failed", { version_id: job.version_id, attempts, terminal, error: message });
}

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey("testnet", ownerId, KeyPair.fromString(process.env.NEAR_OWNER_PRIVATE_KEY));
const near = await connect({ networkId: "testnet", nodeUrl: rpcUrl, keyStore });
const account = await near.account(ownerId);

while (true) {
  try {
    const job = await claimJob();
    if (job) {
      try { await processJob(job, account); } catch (error) { await failJob(job, error); }
    }
  } catch (error) {
    console.error("Publication worker loop failed", error instanceof Error ? error.message : "unknown error");
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
