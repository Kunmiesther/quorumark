import { PUBLIC_NEAR_EVIDENCE_CONTRACT_ID, PUBLIC_NEAR_NETWORK, PUBLIC_NEAR_RPC_URL } from "@/lib/public-env";
import { actionCreators } from "@near-wallet-selector/core";
import { getNearSelector } from "@/lib/wallet/near";

export const PUBLICATION_SCHEMA_VERSION = "quorumark.publication.v1" as const;
const PUBLICATION_DOMAIN = "quorumark:near:testnet:publication:v1";

export type PublicationRecord = {
  strategy_id: string;
  version_id: string;
  creator_near_account: string;
  strategy_commitment: string;
  backtest_commitment: string;
  published_at: string;
  network: "near:testnet";
};

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

export async function publicationCommitment(record: PublicationRecord): Promise<string> {
  const input = canonicalize({ domain: PUBLICATION_DOMAIN, schema_version: PUBLICATION_SCHEMA_VERSION, record });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertPublicationContractReady(): Promise<void> {
  if (!PUBLIC_NEAR_EVIDENCE_CONTRACT_ID) throw new Error("NEAR publication evidence is not configured yet.");
  const args_base64 = btoa("{}");
  const response = await fetch(PUBLIC_NEAR_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "quorumark-publication-preflight",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: PUBLIC_NEAR_EVIDENCE_CONTRACT_ID,
        method_name: "owner_id",
        args_base64,
      },
    }),
  });
  const payload = await response.json().catch(() => null) as { result?: { result?: number[]; error?: string }; error?: unknown } | null;
  if (!response.ok || payload?.error || payload?.result?.error || !payload?.result?.result) {
    throw new Error("NEAR publication evidence is not ready yet. The testnet contract must be initialized before approval.");
  }
}

export async function anchorPublication(
  record: Pick<PublicationRecord, "strategy_id" | "version_id" | "creator_near_account" | "network">,
  commitment: string,
) {
  if (PUBLIC_NEAR_NETWORK !== "testnet") throw new Error("Publication evidence is restricted to NEAR testnet.");
  if (!PUBLIC_NEAR_EVIDENCE_CONTRACT_ID) throw new Error("NEAR publication evidence is not configured yet.");
  await assertPublicationContractReady();
  const selector = await getNearSelector();
  const account = selector.store.getState().accounts?.[0]?.accountId;
  if (!account || account !== record.creator_near_account) throw new Error("The selected NEAR account does not match the strategy creator.");
  const wallet = await selector.wallet();
  if (!wallet.signAndSendTransaction) throw new Error("The selected wallet cannot approve a NEAR testnet transaction.");
  const outcome = await wallet.signAndSendTransaction({
    signerId: account,
    receiverId: PUBLIC_NEAR_EVIDENCE_CONTRACT_ID,
    actions: [actionCreators.functionCall(
      "record_publication",
      { commitment, strategy_id: record.strategy_id, version_id: record.version_id },
      BigInt("30000000000000"),
      BigInt(0),
    )],
  });
  if (!outcome || !("transaction" in outcome) || !outcome.transaction?.hash) throw new Error("The wallet did not return a verifiable transaction outcome.");
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  if (status.Failure) throw new Error("The NEAR testnet publication transaction failed.");
  return { transaction_hash: outcome.transaction.hash, receiver: PUBLIC_NEAR_EVIDENCE_CONTRACT_ID, network: "near:testnet" as const, outcome };
}
