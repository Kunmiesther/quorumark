import { http } from "viem";
import { SPOT_ROUTES } from "./spot";

type RpcNetwork = "base" | "bnb";
const nextPublicRead = new Map<RpcNetwork, number>();

/** Server configuration only. Never accept an RPC URL from a trade or wallet request. */
export function chainRpcConfig(network: RpcNetwork, purpose: "state" | "receipt" = "state") {
  const configured =
    process.env[network === "base"
      ? purpose === "receipt" ? "TURTLEBOT_BASE_RECEIPT_RPC_URL" : "TURTLEBOT_BASE_RPC_URL"
      : "TURTLEBOT_BNB_RPC_URL"]?.trim();
  if (configured) {
    try {
      if (new URL(configured).protocol !== "https:") throw new Error();
    } catch {
      // Do not disclose RPC credentials in configuration errors.
      throw new Error("Dedicated RPC configuration is invalid; HTTPS is required.");
    }
  }
  const url = configured || (network === "base" && purpose === "receipt"
    ? "https://mainnet.base.org"
    : SPOT_ROUTES[network].rpc);
  // Setting an override to a public endpoint does not remove its rate limits.
  // Keep account verification paced even when the public Base RPC is configured.
  const publicOrigins = new Set([
    new URL(SPOT_ROUTES[network].rpc).origin,
    ...(network === "base" ? ["https://mainnet.base.org"] : []),
  ]);
  return {
    url,
    dedicated: !!configured && !publicOrigins.has(new URL(url).origin),
  };
}

/** Shared pacing across spot swaps, receipts and SynFutures within this process. */
export function chainRpcTransport(network: RpcNetwork, purpose: "state" | "receipt" = "state") {
  const { url, dedicated } = chainRpcConfig(network, purpose);
  return http(url, {
    timeout: 12_000,
    retryCount: 0,
    fetchFn: async (input, init) => {
      if (!dedicated) {
        const slot = Math.max(Date.now(), nextPublicRead.get(network) ?? 0);
        if (slot - Date.now() > 10_000) throw new Error("Public RPC is busy. Retry shortly.");
        nextPublicRead.set(network, slot + 400);
        const delay = slot - Date.now();
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return fetch(input, init);
    },
  });
}
