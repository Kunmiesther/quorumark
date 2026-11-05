/**
 * Isolated NEAR Intents boundary.
 *
 * The official flow is quote request -> solver quote -> wallet authorization ->
 * relay -> onchain settlement verification. Until a relay endpoint and
 * supported testnet route are configured, Quorumark deliberately exposes only
 * a typed sandbox adapter. It never manufactures a quote, transaction hash, or
 * settlement confirmation.
 */
export type IntentEnvironment = "sandbox" | "near_testnet";
export type IntentQuote = { id: string; assetIn: string; assetOut: string; amountIn: string; amountOut: string; expiresAt: string; environment: IntentEnvironment };
export type IntentReceipt = { status: "pending" | "settled" | "failed"; transactionHash?: string; verified: boolean; reason?: string };

export interface NearIntentsAdapter {
  supportedAssets(): Promise<string[]>;
  requestQuote(input: { assetIn: string; assetOut: string; amountIn: string }): Promise<IntentQuote>;
  prepareTransaction(quote: IntentQuote): Promise<{ quoteId: string; payload: unknown }>;
  verifySettlement(quote: IntentQuote, receipt: IntentReceipt): Promise<IntentReceipt>;
}

export function createSandboxNearIntentsAdapter(): NearIntentsAdapter {
  return {
    async supportedAssets() { return ["NEAR", "USDC"]; },
    async requestQuote() { throw new Error("NEAR Intents sandbox has no settlement quotes configured"); },
    async prepareTransaction() { throw new Error("Transaction preparation is disabled until a supported NEAR Intents environment is configured"); },
    async verifySettlement(_quote, receipt) {
      if (!receipt.transactionHash) return { status: "failed", verified: false, reason: "No transaction hash to verify against the network" };
      return { ...receipt, verified: false, reason: "Network verification adapter is not configured" };
    },
  };
}
