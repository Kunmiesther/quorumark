import { PUBLIC_NEAR_EVIDENCE_CONTRACT_ID, PUBLIC_NEAR_NETWORK, PUBLIC_NEAR_RPC_URL } from "@/lib/public-env";

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
