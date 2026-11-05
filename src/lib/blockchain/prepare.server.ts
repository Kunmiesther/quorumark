import { formatUnits, type Address } from "viem";
import type { NetworkWallet } from "./catalog";
import { SPOT_ROUTES, spotAmounts, type SpotRequest } from "./spot";
import {
  createSpotReader,
  previewSpotSwap,
  type SpotReader,
  type SpotPreview,
} from "./spot.server";
import { assertPlan, planTransaction, type SwapPlan } from "./transactions";
import type { MarketSnapshot } from "@/lib/ai/committee/schema";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";

export function spotCouncilSnapshot(id: string, preview: SpotPreview): MarketSnapshot {
  const config = SPOT_ROUTES[preview.network];
  return {
    candidate_id: `spot:${id}`,
    strategy: "manual_spot",
    symbol: `${preview.sellSymbol}-${preview.buySymbol}`,
    timeframe: "block",
    candle_close_ms: preview.blockTimestamp,
    spot_swap: {
      chain_id: config.chainId,
      router: config.router,
      pool: preview.pool,
      observed_block: preview.block,
      sell_asset: preview.sellSymbol,
      buy_asset: preview.buySymbol,
      token_contract: preview.token.address,
      sell_amount: preview.sellAmount,
      quoted_output: preview.buyAmount,
      minimum_output: preview.minimumReceived,
      slippage_bps: preview.slippageBps,
      pool_fee_bps: preview.feeBps,
      evidence_kind: "block_quote_without_candles",
    },
    deterministic: {
      proposed_direction: preview.sellSymbol === config.gas ? "short" : "long",
      entry: null,
      entry_zone: null,
      invalidation: null,
      tp_levels: [],
      regime: null,
      trend_state: null,
      trend_slope_pct: null,
      atr_pct: null,
      recent_closes: [],
      recent_highs: [],
      recent_lows: [],
      volume_profile: [],
    },
  };
}

/** Compiles and simulates a wallet request; never signs or broadcasts. */
export async function prepareWalletSwap(
  id: string,
  request: SpotRequest,
  wallet: NetworkWallet,
  review: (snapshot: MarketSnapshot) => Promise<CommitteeEvaluationDto | null>,
  rpc: SpotReader = createSpotReader(request.network),
  clock = Date.now,
): Promise<SwapPlan> {
  let preview = await previewSpotSwap(request, wallet, rpc, clock());
  const config = SPOT_ROUTES[request.network];
  const amounts = spotAmounts(request);
  const balance = amounts.sellingNative ? preview.nativeBalance : preview.stableBalance;
  // Raw comparison avoids float rounding on large or high-precision balances.
  const { parseUnits } = await import("viem");
  if (parseUnits(balance, amounts.decimals) < amounts.raw)
    throw new Error(`Insufficient ${amounts.sellSymbol} balance on ${config.name}.`);
  let action: SwapPlan["action"] = "swap";
  let council: CommitteeEvaluationDto | null = null;
  if (!amounts.sellingNative && BigInt(preview.allowanceRaw) < amounts.raw) {
    action = BigInt(preview.allowanceRaw) > 0n ? "reset_approval" : "approve";
  } else {
    if (preview.simulation !== "passed") throw new Error(preview.blockers.join(" "));
    council = await review(spotCouncilSnapshot(id, preview));
    if (!council?.availableRoles.length)
      throw new Error(
        "Council did not respond. No swap was submitted. Retry review when a provider is available.",
      );
    // Model latency cannot make an old quote executable. Refresh chain evidence AFTER review.
    const prior = preview;
    preview = await previewSpotSwap(request, wallet, rpc, clock());
    if (
      preview.pool.toLowerCase() !== prior.pool.toLowerCase() ||
      BigInt(preview.quotedOutputRaw) <
        (BigInt(prior.quotedOutputRaw) * BigInt(10_000 - request.slippageBps)) / 10_000n
    )
      throw new Error(
        "Route or price changed during Council review. Prepare again to review the updated route.",
      );
    if (preview.simulation !== "passed") throw new Error(preview.blockers.join(" "));
  }
  const fields = {
    id,
    request,
    action,
    owner: wallet.public_address as Address,
    chainId: config.chainId,
    fee: preview.poolFee,
    outputRaw: preview.quotedOutputRaw,
    expiresAt: preview.expiresAt,
    minimumReceived: preview.minimumReceived,
    estimatedNetworkFee: preview.estimatedNetworkFee ?? "",
    review: council,
  };
  const plan: SwapPlan = { ...fields, transaction: planTransaction(fields) };
  if (action !== "swap") {
    const tx = plan.transaction;
    const [gas, price] = await Promise.all([
      rpc.simulate({ account: tx.from, to: tx.to, data: tx.data, value: BigInt(tx.value) }),
      rpc.gasPrice(),
    ]);
    plan.estimatedNetworkFee = formatUnits(gas * price, 18);
    if (parseUnits(preview.nativeBalance, 18) < gas * price)
      throw new Error(`Insufficient ${config.gas} for the estimated approval gas.`);
  }
  assertPlan(plan, clock());
  return plan;
}
