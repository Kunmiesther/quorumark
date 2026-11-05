import { z } from "zod";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import {
  compileSpotSwap,
  SPOT_ROUTES,
  spotAmounts,
  spotToken,
  spotRequestSchema,
  type SpotRequest,
} from "./spot";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";

export const prepareSwapSchema = spotRequestSchema
  .extend({ requestId: z.string().uuid() })
  .strict();
export const receiptRequestSchema = z
  .object({
    id: z.string().uuid(),
    hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .strict();
export type SwapAction = "approve" | "reset_approval" | "swap";
export type SwapPlan = {
  id: string;
  request: SpotRequest;
  action: SwapAction;
  owner: Address;
  chainId: number;
  fee: number;
  outputRaw: string;
  expiresAt: number;
  minimumReceived: string;
  estimatedNetworkFee: string;
  review: CommitteeEvaluationDto | null;
  transaction: { from: Address; to: Address; data: Hex; value: Hex; chainId: Hex };
};
export type SwapRecord = {
  id: string;
  plan: SwapPlan;
  status:
    "prepared" | "signing" | "submitted" | "confirmed" | "reverted" | "declined" | "cancelled";
  tx_hash: string | null;
  transaction_nonce: string | null;
  hash_verified: boolean;
  previous_hashes: string[];
  receipt: {
    block: string;
    confirmations: number;
    gasUsed: string;
    feeNative: string;
    feeComplete: boolean;
    checkedAt: string;
  } | null;
};

export function sameSwapRequest(a: SpotRequest, b: SpotRequest) {
  return (
    a.network === b.network &&
    a.walletId === b.walletId &&
    a.direction === b.direction &&
    a.amount === b.amount &&
    a.slippageBps === b.slippageBps &&
    spotToken(a).address === spotToken(b).address &&
    spotToken(a).decimals === spotToken(b).decimals &&
    spotToken(a).symbol === spotToken(b).symbol
  );
}

/** Same deterministic compiler runs on server and browser: no arbitrary target or calldata. */
export function planTransaction(
  plan: Pick<SwapPlan, "request" | "owner" | "action" | "fee" | "outputRaw" | "expiresAt">,
): SwapPlan["transaction"] {
  const request = spotRequestSchema.parse(plan.request);
  const config = SPOT_ROUTES[request.network];
  if (!/^0x[0-9a-fA-F]{40}$/.test(plan.owner)) throw new Error("Invalid wallet address.");
  const amounts = spotAmounts(request);
  if (plan.action !== "swap") {
    if (amounts.sellingNative || !["approve", "reset_approval"].includes(plan.action))
      throw new Error("Unexpected token approval.");
    return {
      from: plan.owner,
      to: amounts.tokenIn,
      value: "0x0",
      chainId: `0x${config.chainId.toString(16)}`,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [config.router, plan.action === "reset_approval" ? 0n : amounts.raw],
      }),
    };
  }
  const compiled = compileSpotSwap(
    request,
    plan.owner,
    plan.fee,
    BigInt(plan.outputRaw),
    BigInt(Math.floor(plan.expiresAt / 1000)),
  );
  return {
    from: plan.owner,
    to: compiled.transaction.to,
    data: compiled.transaction.data,
    value: `0x${compiled.transaction.value.toString(16)}`,
    chainId: `0x${config.chainId.toString(16)}`,
  };
}

export function assertPlan(plan: SwapPlan, now = Date.now()) {
  if (
    !Number.isSafeInteger(plan.expiresAt) ||
    plan.expiresAt - now < 15_000 ||
    plan.expiresAt - now > 300_000
  )
    throw new Error("This review expired. Prepare a fresh transaction.");
  if (plan.chainId !== SPOT_ROUTES[plan.request.network].chainId)
    throw new Error("Plan chain mismatch.");
  const expected = planTransaction(plan);
  if (
    !Object.entries(expected).every(
      ([key, value]) =>
        value.toLowerCase() === plan.transaction[key as keyof typeof expected]?.toLowerCase(),
    )
  )
    throw new Error("Transaction does not match the reviewed swap.");
  if (plan.action === "swap" && !plan.review?.availableRoles.length)
    throw new Error("Council has not responded to this swap review.");
}

export function matchesTransaction(
  plan: SwapPlan,
  tx: { from: string; to: string | null; input: string; value: bigint },
) {
  const expected = planTransaction(plan);
  return (
    tx.from.toLowerCase() === expected.from.toLowerCase() &&
    tx.to?.toLowerCase() === expected.to.toLowerCase() &&
    tx.input.toLowerCase() === expected.data.toLowerCase() &&
    tx.value === BigInt(expected.value)
  );
}
