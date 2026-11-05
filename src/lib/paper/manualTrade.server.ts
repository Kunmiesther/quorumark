// Manual single-entry paper trade — the first real "atomic submit" path in
// this codebase. Reuses the SAME mandatory AI-orchestration gate the
// automated engine uses (orchestratePaperCandidate: fan out to the 3-seat
// committee, ONYX synthesis, one consolidated risk check) so a manual entry
// can never bypass the database's `paper_orchestration_missing` invariant —
// there is no shortcut path to paper_open_position from here.
//
// SCOPE: single entry only (rung_count=1, no ladder/DCA), legacy authority
// mode only. Rejects cleanly if the account is in dynamic_universe mode
// (reserved-leg execution isn't implemented here yet).
//
// AUTHORITY: PAPER ONLY. No import edge to the signer, broker, or any live
// venue — same guarantee as aiOrchestration.server.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAKER_FEE_RATE } from "@/lib/paper/ladder";
import { openPosition as repoOpenPosition } from "@/lib/paper/repository";
import { fingerprintPayload } from "@/lib/paper/operations";
import { orchestratePaperCandidate, type PaperCandidateInput } from "@/lib/paper/aiOrchestration.server";

/** Fixed default until a customization command exists. Well inside the $600 default wallet balance. */
export const MANUAL_TRADE_DEFAULTS = { marginUsd: 50, leverage: 5 } as const;

export interface ManualTradeInput {
  symbol: string; // "BTC-USDT"
  direction: "long" | "short";
  entryPrice: number;
  stopLevel: number | null;
  tpLevels: number[];
  candleCloseMs: number;
  tickSize: number | null;
  stepSize: number | null;
  maxLeverage: number | null;
  trendState: string | null;
  strategy: string; // e.g. "telegram_manual"
}

export type ManualTradeResult =
  | { ok: true; positionId: string; qty: number; marginUsd: number; leverage: number }
  | { ok: false; reason: string; detail?: string };

function roundToStep(qty: number, step: number | null): number {
  if (!step || step <= 0) return qty;
  return Math.floor(qty / step) * step;
}

export async function placeManualPaperTrade(
  admin: SupabaseClient,
  userId: string,
  input: ManualTradeInput,
): Promise<ManualTradeResult> {
  const { data: authority } = await admin
    .from("paper_engine_authority")
    .select("mode")
    .eq("user_id", userId)
    .maybeSingle();
  if (authority && authority.mode !== "legacy") {
    return { ok: false, reason: "unsupported_authority_mode", detail: String(authority.mode) };
  }

  const leverage = Math.min(MANUAL_TRADE_DEFAULTS.leverage, input.maxLeverage ?? MANUAL_TRADE_DEFAULTS.leverage);
  const marginUsd = MANUAL_TRADE_DEFAULTS.marginUsd;
  const rawQty = (marginUsd * leverage) / input.entryPrice;
  const qty = roundToStep(rawQty, input.stepSize);
  if (!(qty > 0)) return { ok: false, reason: "size_rounds_to_zero" };

  const baseSymbol = input.symbol.split("-")[0];
  const walletKey = `${baseSymbol}-${input.direction}`;

  const { data: existingWallet } = await admin
    .from("paper_wallets")
    .select("id, balance, open_position_id, status, execution_enabled")
    .eq("user_id", userId)
    .eq("wallet_key", walletKey)
    .maybeSingle();

  let walletId: string;
  let walletBalance: number;
  if (existingWallet) {
    if (existingWallet.open_position_id) return { ok: false, reason: "wallet_occupied" };
    if (existingWallet.status !== "active" || !existingWallet.execution_enabled) {
      return { ok: false, reason: "wallet_disabled" };
    }
    walletId = existingWallet.id;
    walletBalance = Number(existingWallet.balance);
  } else {
    const { data: created, error } = await admin
      .from("paper_wallets")
      .insert({ user_id: userId, wallet_key: walletKey })
      .select("id, balance")
      .single();
    if (error || !created) return { ok: false, reason: "wallet_create_failed" };
    walletId = created.id;
    walletBalance = Number(created.balance);
  }

  if (marginUsd > walletBalance) return { ok: false, reason: "insufficient_wallet_balance" };

  const candidate: PaperCandidateInput = {
    key: `telegram:${userId}:${input.symbol}:${input.direction}:${input.candleCloseMs}`,
    symbol: input.symbol,
    direction: input.direction,
    leg: input.strategy,
    entryCandleTs: input.candleCloseMs,
    fillPx: input.entryPrice,
    stopLevel: input.stopLevel,
    tpLevel: input.tpLevels[0] ?? null,
    zoneLower: input.entryPrice,
    zoneUpper: input.entryPrice,
    margin: marginUsd,
    notional: qty * input.entryPrice,
    leverage,
    regime: null,
    trendState: input.trendState,
    trendSlopePct: null,
    movementScore: null,
    htf: null,
    env: null,
    deterministicApproved: true,
  };

  const orchestration = await orchestratePaperCandidate(admin, userId, candidate);
  if (!orchestration.allowed || !orchestration.traceId) {
    return {
      ok: false,
      reason: orchestration.blockedReason ?? orchestration.terminalOutcome,
      detail: orchestration.onyxRationale,
    };
  }

  const entryFee = qty * input.entryPrice * MAKER_FEE_RATE;
  const payload = {
    wallet_key: walletKey,
    symbol: input.symbol,
    direction: input.direction,
    entry_price: input.entryPrice,
    entry_ts: new Date(input.candleCloseMs).toISOString(),
    entry_candle_ts_ms: input.candleCloseMs,
    tp_level: input.tpLevels[0] ?? null,
    stop_level: input.stopLevel,
    zone_lower: input.entryPrice,
    zone_upper: input.entryPrice,
    zone_level: input.entryPrice,
    size_qty: qty,
    size_notional: qty * input.entryPrice,
    margin: marginUsd,
    leverage,
    entry_fee: entryFee,
    opened_from_signal: input.strategy,
    last_seen_candle_ts_ms: input.candleCloseMs,
    trend_at_entry: input.trendState,
    trend_slope_pct_at_entry: null,
    strategy: input.strategy,
    regime_at_entry: null,
    onyx_rationale: orchestration.onyxRationale.slice(0, 2000),
    orchestration_trace_id: orchestration.traceId,
    rung_count: 1,
    first_fill_vwap: input.entryPrice,
    fills: [{ price: input.entryPrice, qty, margin: marginUsd, tp: input.tpLevels[0] ?? input.entryPrice }],
    resize_levels: [],
    pending_rungs: [],
    ladder_total_margin: marginUsd,
    ladder_total_notional: qty * input.entryPrice,
    ladder_total_rungs: 1,
    ladder_strategy: false,
  };

  const opKey = `manual_open:${userId}:${candidate.key}`;
  const fingerprint = await fingerprintPayload(payload);
  const opened = await repoOpenPosition(admin, { userId, walletId, payload, opKey, fingerprint });

  if (!opened.result.ok) {
    return { ok: false, reason: opened.result.reason, detail: opened.result.detail };
  }

  return { ok: true, positionId: opened.result.value.position_id, qty, marginUsd, leverage };
}
