import {
  createPublicClient,
  formatUnits,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hash,
} from "viem";
import { base, bsc } from "viem/chains";
import { SPOT_ROUTES } from "./spot";
import { spotTransport } from "./spot.server";
import { matchesTransaction, type SwapPlan, type SwapRecord } from "./transactions";

export interface ReceiptReader {
  chainId(): Promise<number>;
  transaction(hash: Hash): Promise<{
    from: string;
    to: string | null;
    input: string;
    value: bigint;
    nonce: number;
  } | null>;
  receipt(hash: Hash): Promise<{
    blockNumber: bigint;
    blockHash: string;
    status: "success" | "reverted";
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    l1Fee?: bigint;
  } | null>;
  block(number?: bigint): Promise<{ number: bigint; hash: string }>;
}
export function createReceiptReader(plan: SwapPlan): ReceiptReader {
  const client = createPublicClient({
    chain: plan.request.network === "base" ? base : bsc,
    transport: spotTransport(plan.request.network),
  });
  return {
    chainId: () => client.getChainId(),
    transaction: async (hash) => {
      try {
        return await client.getTransaction({ hash });
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return null;
        throw e;
      }
    },
    receipt: async (hash) => {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
    block: async (blockNumber) => {
      const b = await client.getBlock(blockNumber === undefined ? {} : { blockNumber });
      return { number: b.number, hash: b.hash };
    },
  };
}
/** A hash is NOT a fill. Verify sender, destination, exact calldata/value and canonical receipt. */
export async function reconcileSwapReceipt(
  plan: SwapPlan,
  hash: Hash,
  rpc = createReceiptReader(plan),
  expectedNonce: string | null = null,
): Promise<Pick<SwapRecord, "status" | "receipt" | "transaction_nonce" | "hash_verified">> {
  if ((await rpc.chainId()) !== SPOT_ROUTES[plan.request.network].chainId)
    throw new Error("Receipt RPC chain mismatch.");
  const tx = await rpc.transaction(hash);
  if (!tx)
    return {
      status: "submitted",
      receipt: null,
      transaction_nonce: expectedNonce,
      hash_verified: false,
    };
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0)
    throw new Error("Invalid transaction nonce.");
  if (expectedNonce !== null && tx.nonce.toString() !== expectedNonce)
    throw new Error(
      "Replacement transaction uses a different nonce. It is not a speed-up or cancellation of this request.",
    );
  const cancelled =
    expectedNonce !== null &&
    tx.from.toLowerCase() === plan.owner.toLowerCase() &&
    tx.to?.toLowerCase() === plan.owner.toLowerCase() &&
    tx.value === 0n &&
    tx.input === "0x";
  if (!matchesTransaction(plan, tx) && !cancelled)
    throw new Error("Transaction does not match this wallet and reviewed request.");
  const identity = { transaction_nonce: tx.nonce.toString(), hash_verified: true };
  const receipt = await rpc.receipt(hash);
  if (!receipt) return { status: "submitted", receipt: null, ...identity };
  const [canonical, tip] = await Promise.all([rpc.block(receipt.blockNumber), rpc.block()]);
  if (canonical.hash !== receipt.blockHash || tip.number < receipt.blockNumber)
    return { status: "submitted", receipt: null, ...identity };
  const confirmations = Number(tip.number - receipt.blockNumber + 1n);
  return {
    ...identity,
    status:
      confirmations < 2
        ? "submitted"
        : receipt.status === "success"
          ? cancelled
            ? "cancelled"
            : "confirmed"
          : "reverted",
    receipt: {
      block: receipt.blockNumber.toString(),
      confirmations,
      gasUsed: receipt.gasUsed.toString(),
      feeNative: formatUnits(
        receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n),
        18,
      ),
      feeComplete: plan.request.network !== "base" || receipt.l1Fee !== undefined,
      checkedAt: new Date().toISOString(),
    },
  };
}
