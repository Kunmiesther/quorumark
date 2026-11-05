/**
 * PAPER-FILL ENGINE — SIMULATION ONLY.
 *
 * ⚠️ SAFETY INVARIANTS (do not weaken):
 * - This module NEVER calls a signer, execution-broker, exchange venue,
 *   ApeX order/cancel/leverage/withdraw, `order_intents`, `orders`, or
 *   `apex_execution_credentials`. It writes ONLY to `paper_wallets`,
 *   `paper_positions`, `paper_trades` under the caller's RLS.
 * - It uses only PUBLIC market data (ApeX Omni public klines endpoint) via
 *   `src/lib/paper/feed.ts`. No auth headers are ever sent to a venue.
 * - Fills are only counted when a REAL completed candle's high (long) or
 *   low (short) actually TOUCHES the TP level, or when a REAL candle CLOSE
 *   crosses the stop level. There are no assumed fills.
 * - `is_live` never becomes true. No env flag toggles this path into real
 *   execution.
 * - A valid 2-of-3 1h/4h/1d alignment routes mechanically to the Long or
 *   Short wallet. Failed-alignment opportunities route Council -> Onyx and,
 *   only when approved, execute as DCA in the Strategy wallet. Council and
 *   Onyx are selection stages, never extra wallets.
 * - Mechanical rules size and manage every position. The Hedge wallet may
 *   protect an opposite open core position, but no AI can resize or close a
 *   live position directly.
 *
 * Current wallet campaign contract:
 *   - coordinated long, short, hedge, and strategy wallet roles
 *   - every new campaign uses 5% of its destination wallet's latest settled
 *     balance, frozen at creation and split equally across five rungs
 *   - leverage is capped by the venue's symbol limit
 *   - One active campaign per symbol in each of four role wallets
 *   - Costs: 5 bps taker fee + 2 bps slippage per fill
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { isPaperEngineEnabled } from "./killSwitch";
import type { Database } from "@/integrations/supabase/types";
import { resolveGlmTransport } from "@/lib/ai/glmTransport.server";
import {
  evaluate,
  findConfirmedSwings,
  groupLiquidityZones,
  wilderAtrSeries,
  confirmedEntriesSince,
  computeTrend,
  trendAllowsDirection,
  TS,
  HIGH,
  LOW,
  CLOSE,
  VOLUME,
  type Direction,
  type TrendInfo,
  type TrendState,
} from "./signal";
import { ENTRY_FRESHNESS_CANDLES, pickFreshUntradedAccumulatorEntry } from "./eligibility";
import { fetchCandlesBounded } from "./market";
import {
  openPosition as repoOpenPosition,
  closePosition as repoClosePosition,
  reducePosition as repoReducePosition,
  addRungAtomic as repoAddRung,
} from "./repository";
import { fingerprintPayload } from "./operations";
import { classifyRegime, type Regime } from "./regime";
import { legForRegime, type StrategyLeg } from "./routing";
import { detectHtfBos } from "./htfBos";
import { evaluateSetupTimeframes } from "./timeframePolicy";
import {
  shouldPromote,
  isAdverseHtfBos,
  computeBreakevenStop,
  runnerBreakevenStopHit,
} from "./htfPromotion";
import { detectSweep } from "./sweep";
import {
  findFvgs, findSwings as findHunterSwings, type Fvg, type HunterSwing,
} from "./hunter";
import {
  decideOnyxForCandidates, computeBenchedWallets,
  type OnyxCandidate, type OnyxOpenPosition,
  type FleetSnapshot, type Decision,
} from "@/lib/onyx/decide";

import {
  buildLadder, deepestRungPrice, ladderNotional, ladderQty,
  pendingRungsHitByCandle, MAKER_FEE_RATE,
  dcaRungsForLeverage, dcaMarginPerRungForLeverage,
  DCA_RUNG_TP_PCT,
  resolveCampaignHardStop,
  type Rung,
} from "./ladder";
import {
  SNIPER_MAX_RUNGS,
  sniperTpPrice,
} from "./sniperProfile";
import { sweepTpPrice } from "./sweep";
import {
  CANONICAL_SCAN_SYMBOL_SET,
  ZEN_SWEEP,
  buildZenSweepLadder,
  decideZenSweepExit,
  passesZenSweepAlignment,
} from "./zenSweepContract";
import {
  buildWalletCampaignLadder,
  sizeWalletCampaign,
  WALLET_CAMPAIGN_RUNG_COUNT,
} from "./walletCampaignSizing";
import { effectiveTp } from "./effectiveTp";
import {
  isLadderPosition,
  armLadderHardStop,
  buildArmingPayload,
  LADDER_CONTRACT_VERSION,
} from "./ladder-policy";
import { guardianCloseExitReason, type GuardianExitReason } from "./guardian";





// ─── CONSTANTS (Phase 3 extraction) ────────────────────────────────────────
// Numeric constants and pure predicates now live in ./constants.ts. Re-exported
// here so `import { X } from "@/lib/paper/engine"` remains the public surface
// for every existing caller. See docs/PAPER_ENGINE_ARCHITECTURE.md.
export {
  ONYX_MAX_TOTAL_OPEN,
  ONYX_MAX_ALT_POSITIONS,
  ONYX_BENCH_STOPS,
  ONYX_RECENT_TRADE_LIMIT,
  STARTING_ACCOUNT_BALANCE,
  MMR,
  MAX_HEAT,
  WALLET_BASE,
  MARGIN_FRACTION,
  TARGET_LEVERAGE,
  TAKER_BPS,
  SLIP_BPS,
  FEE_RATE,
  SLIP_RATE,
  EXECUTION_INTERVAL_MIN,
  HEALTH_INTERVAL_MIN,
  SCAN_UNIVERSE_SIZE,
  INTERVAL_MIN,
  SETUP_INTERVAL_1H_MIN,
  SETUP_INTERVAL_4H_MIN,
  FETCH_LIMIT,
  MIN_STRUCTURAL_TP_DISTANCE_PCT,
  MIN_TP_TO_STOP_DISTANCE_RATIO,
  MAX_LOSS_MARGIN_FRAC,
  shouldTriggerMaxLoss,
  HUNTER_K_THRESHOLD,
  HUNTER_RETRACE_WINDOW,
  TREND_FILTER_ENABLED,
  TREND_NEUTRAL_BLOCKS,
  effectiveLeverage,
  DEFAULT_PAPER_SYMBOLS,
  EIGHT_RUNG_CANONICAL_SYMBOLS,
} from "./constants";
import {
  FEE_RATE,
  MAX_HEAT,
  MMR,
  STARTING_ACCOUNT_BALANCE,
  TARGET_LEVERAGE,
  INTERVAL_MIN,
  SETUP_INTERVAL_1H_MIN,
  SETUP_INTERVAL_4H_MIN,
  FETCH_LIMIT,
  HUNTER_K_THRESHOLD,
  HUNTER_RETRACE_WINDOW,
  TREND_FILTER_ENABLED,
  TREND_NEUTRAL_BLOCKS,
  effectiveLeverage,
  ONYX_MAX_TOTAL_OPEN,
  ONYX_MAX_ALT_POSITIONS,
  ONYX_BENCH_STOPS,
  ONYX_RECENT_TRADE_LIMIT,
  DYNAMIC_UNIVERSE_ENABLED,
} from "./constants";

import { planFormation } from "./adaptiveFormation";
import { evaluateEntryAuthorization } from "./entryGuard";
import { reviewHedgeForOpenPosition, type HedgeReviewOutcome } from "./hedgeReview";
import { PAPER_VENUE } from "@/lib/exchanges/venueCapabilities";
import type { EngineGateResult } from "../universe/engineGate";
import { loadDynamicContext, recordPaperOrderIntent, type DynamicOpenContext } from "./dynamicOpen";
import { ensurePodsForScope } from "./podService";
import { selectFreshScoutSides, type RawScoutSignalRow } from "./scoutIngestion";
import { EVIDENCE_SCHEMA_VERSION, RULES_VERSION } from "@/lib/scout/versions";
import { TickAllocator, type ReserveToken } from "./allocator";
import {
  aiSelectionSymbolAvailable,
  campaignSlotKey,
  routeFourWalletOpportunity,
  type SelectionPath,
} from "./fourWalletRouter";


// Local (not re-exported): the anchor-base set is only referenced inside this
// module's routing/capacity logic (altOpenCount for the alt-position cap).
const ANCHOR_BASES = new Set(["BTC", "ETH"]);

// ─── PUBLIC TYPES (Phase 4C extraction) ────────────────────────────────────
// Types and the walletKey helper now live in ./types.ts. Re-exported here so
// callers importing from "@/lib/paper/engine" keep the same public surface.
export type { PaperSymbol, WalletKey, EvalReason, EvaluationDetail, TickResult } from "./types";
export { walletKey } from "./types";
import { walletKey } from "./types";
import type {
  PaperSymbol, EvalReason, EvaluationDetail, TickResult,
} from "./types";

// ─── PRICING / GEOMETRY (Phase 4C extraction) ──────────────────────────────
// Pure slip / TP / stop / protective-swing helpers now live in ./pricing.ts.
// The re-exports below preserve the historical engine.ts public surface
// (`mirrorTpFromStop`, `protectiveSwingForOpen`, `isAdverseBos` were exported
// from engine.ts before this extraction and remain callable via that path).
export {
  mirrorTpFromStop,
  protectiveSwingForOpen,
  isAdverseBos,
} from "./pricing";
import { applySlip, mirrorTpFromStop, stopPivot, protectiveSwingForOpen, isAdverseBos } from "./pricing";
import {
  buildLockoutSet,
  isLockedOut,
  REENTRY_LOCKOUT_CANDLES,
  REENTRY_LOCKOUT_MS,
  type LockoutTradeRow,
} from "./reentryLockout";

// ─── TELEMETRY (Phase 4C extraction) ───────────────────────────────────────
// Best-effort `bot_events` writers now live in ./telemetry.ts.
import { emitBotEvent } from "./telemetry";

// ─── DB row aliases (internal to the engine orchestrator) ─────────────────
type WalletRow = Database["public"]["Tables"]["paper_wallets"]["Row"];
type PositionRow = Database["public"]["Tables"]["paper_positions"]["Row"];

/**
 * Run one paper-tick cycle for the caller.
 * Scans the configured symbol universe with 1h/4h context, manages every open
 * position, then uses completed 15m decisions to fill remaining capacity.
 */
export async function runPaperTick(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<TickResult> {
  // 0. GLOBAL PAPER KILL SWITCH — must be the very first thing in the loop.
  //    When off, exit before any scan, intent, or paper trade. Historical
  //    paper data and settings are untouched. See src/lib/paper/killSwitch.ts.
  if (!isPaperEngineEnabled()) {
    return { ranAt: Date.now(), perSymbol: [], evaluations: [], disabled: true };
  }

  // Both scheduled and on-demand ticks use the same per-plan entry authority.
  // A pause blocks new entries, not management of positions already open.
  const { evaluateAutopilotPaperRuntime } = await import("../automation/paperRuntime.server");
  const { authorizePaperCandidate } = await import("../automation/paperAuthorization");
  const paperRuntime = await evaluateAutopilotPaperRuntime(supabase, userId);

  // 1. Ensure wallets exist for this user (idempotent RPC; seeds defaults + wallets from paper_test_symbols).
  //    `ensure_paper_wallets` is SECURITY DEFINER, executable only by service_role.
  {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.rpc("ensure_paper_wallets", { _user_id: userId });
  }

  // 2. Load enabled symbols, current wallets, open positions.
  const [sRes, wRes, pRes] = await Promise.all([
    supabase.from("paper_test_symbols").select("symbol,tick_size,market_available,enabled,max_leverage").eq("user_id", userId).eq("enabled", true),
    supabase.from("paper_wallets").select("*").eq("user_id", userId).eq("status", "active"),
    supabase.from("paper_positions").select("*").eq("user_id", userId).eq("status", "open"),
  ]);
  if (sRes.error) throw sRes.error;
  if (wRes.error) throw wRes.error;
  if (pRes.error) throw pRes.error;
  const walletsByKey = new Map<string, WalletRow>();
  for (const w of wRes.data ?? []) walletsByKey.set(w.wallet_key, w);
  // A role wallet may hold one campaign for each symbol. The map is therefore
  // keyed by wallet+symbol, never by wallet alone.
  const openBySlot = new Map<string, PositionRow>();
  for (const p of pRes.data ?? []) {
    openBySlot.set(campaignSlotKey(p.wallet_key, p.symbol), p);
  }

  // 2a. SCOUT GUARDIAN directives — the Railway worker's always-on Position
  //     Guardian enqueues risk-reducing actions (cancel unfilled rungs /
  //     force-close) into `scout_guardian_directives`. The worker cannot touch
  //     a position row; the engine is the enforcer and consumes pending
  //     directives here. Loaded + marked consumed with the service-role admin
  //     client (owners have SELECT-only on the queue). Best-effort: a read
  //     error or missing table just means "no directives this tick".
  const guardianCloseByPos = new Map<string, { id: string; exitReason: GuardianExitReason; reasonCode: string }>();
  const guardianCancelByPos = new Map<string, { id: string; reasonCode: string }>();
  // Worker-sourced promotion / repair directives. The paper engine promotes
  // internally (htfPromotion), so these are acknowledged WITHOUT double-
  // applying: we mark them consumed immediately so the queue drains, but
  // never mutate the position. The live broker path will consume them for
  // real once activation opens.
  const workerPromotionAckIds: string[] = [];
  const WORKER_PROMOTION_TYPES = new Set([
    "promote_runner",
    "cancel_fixed_tp",
    "set_breakeven_stop",
    "repair_stop",
  ]);
  let guardianAdmin: SupabaseClient<Database> | null = null;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    guardianAdmin = supabaseAdmin as unknown as SupabaseClient<Database>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dirRows } = await (guardianAdmin.from("scout_guardian_directives" as never) as any)
      .select("id, position_id, directive_type, reason_code")
      .eq("user_id", userId)
      .eq("status", "pending");
    for (const r of (dirRows ?? []) as Array<{ id: string; position_id: string; directive_type: string; reason_code: string }>) {
      if (r.directive_type === "close_position") {
        guardianCloseByPos.set(r.position_id, { id: r.id, exitReason: guardianCloseExitReason(r.reason_code), reasonCode: r.reason_code });
      } else if (r.directive_type === "cancel_unfilled_rungs") {
        guardianCancelByPos.set(r.position_id, { id: r.id, reasonCode: r.reason_code });
      } else if (WORKER_PROMOTION_TYPES.has(r.directive_type)) {
        // Engine-authoritative types: acknowledge, never re-apply.
        workerPromotionAckIds.push(r.id);
      }
    }
  } catch {
    /* best-effort — no directives applied this tick */
  }
  const markDirectiveConsumed = async (id: string): Promise<void> => {
    if (!guardianAdmin) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (guardianAdmin.from("scout_guardian_directives" as never) as any)
        .update({ status: "consumed", consumed_at: new Date().toISOString(), consumed_by: "paper_engine" })
        .eq("id", id);
    } catch {
      /* best-effort */
    }
  };
  // Drain worker-sourced promotion acks now so the queue does not accumulate
  // across cycles. No-op if the engine has already promoted the same position
  // internally — that is exactly the "safe handle" contract.
  for (const id of workerPromotionAckIds) await markDirectiveConsumed(id);


  // 2b. Load the shared cross-margin account row (created by ensure_paper_wallets).
  //     All balance/realized_pnl bookkeeping now flows through this single row —
  //     per-wallet `balance`/`floor_hit` fields are no longer read for gating.
  type PaperAccount = { user_id: string; balance: number; realized_pnl: number };
  const accRes = await supabase
    .from("paper_accounts" as never)
    .select("user_id,balance,realized_pnl")
    .eq("user_id", userId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((accRes as any).error) throw (accRes as any).error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountRow = ((accRes as any).data ?? { user_id: userId, balance: STARTING_ACCOUNT_BALANCE, realized_pnl: 0 }) as PaperAccount;
  let accountBalance = Number(accountRow.balance);
  let realizedDelta = 0;
  const startingAccountBalance = accountBalance;

  // Load every `opened_from_signal` identity this user has ever traded so the
  // Phase-A candidate collection can skip re-proposing a setup that a wallet
  // has already opened (fresh but stale-in-identity). Bounded by recency to
  // keep the query cheap; the freshness window is only a few candles so old
  // history cannot collide with new candidates anyway.
  const tradedRes = await supabase
    .from("paper_positions")
    .select("opened_from_signal")
    .eq("user_id", userId)
    .not("opened_from_signal", "is", null)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (tradedRes.error) throw tradedRes.error;
  const tradedKeys = new Set<string>();
  for (const r of tradedRes.data ?? []) {
    if (r.opened_from_signal) tradedKeys.add(r.opened_from_signal);
  }

  // 2c. Load the latest Scout market_regime per symbol for this user (P2).
  //     Non-blocking best-effort — if the query fails or a symbol has no row
  //     yet, we treat regime as `unknown` and the adaptive planner falls
  //     through to the leverage-tiered ladder (byte-for-byte the legacy
  //     behavior). Only the newest scout_signals row per symbol counts;
  //     Scout writes one per scan and older rows are ignored.
  const regimeBySymbol = new Map<string, import("../scout/regime").MarketRegime>();
  try {
    const regimeRes = await supabase
      .from("scout_signals")
      .select("symbol,market_regime,created_at")
      .eq("user_id", userId)
      .not("market_regime", "is", null)
      .order("created_at", { ascending: false })
      .limit(500);
    for (const row of regimeRes.data ?? []) {
      if (!regimeBySymbol.has(row.symbol)) {
        regimeBySymbol.set(
          row.symbol,
          row.market_regime as import("../scout/regime").MarketRegime,
        );
      }
    }
  } catch {
    // Regime lookup is advisory; adaptive planner defaults to `unknown`.
  }

  // 2d. Dynamic universe gate (paper-only).
  //
  // Constructed from `DYNAMIC_UNIVERSE_ENABLED` (constants.ts). While the
  // flag is false — the current committed state — the gate is INACTIVE and
  // the legacy Hunter / Sniper / Accumulator open path (`repoOpenPosition`
  // in Phase C) is the sole authority for opening paper positions.
  //
  // The Phase A.5 Scout ingestion block below still runs, but every
  // synthesized candidate short-circuits with `blocked_universe_capacity`
  // because `universeGate.active === false`. The code path is preserved so
  // flipping the flag on (plus wiring `computeUniverseGate` back in) is a
  // single-turn re-enable, not a rewrite.
  const openSymbolsForGate = Array.from(new Set((pRes.data ?? []).map((p) => p.symbol)));
  const universeGate: EngineGateResult = {
    active: DYNAMIC_UNIVERSE_ENABLED,
    reason: DYNAMIC_UNIVERSE_ENABLED
      ? "dynamic_universe_enabled_but_gate_compute_not_wired"
      : "dynamic_universe_disabled",
    allowedNewEntries: new Set<string>(),
    retainedSymbols: openSymbolsForGate,
    capacity: null,
    snapshotId: null,
    rankedSymbols: [],
  };





  const enabledSymbols = (sRes.data ?? []).filter(
    (s) => s.market_available !== false && CANONICAL_SCAN_SYMBOL_SET.has(s.symbol),
  );
  const tickBySymbol = new Map<string, number | null>();
  const leverageBySymbol = new Map<string, number>();
  for (const s of enabledSymbols) {
    // Dedupe duplicates in paper_test_symbols by keeping the MAX venue cap per symbol.
    // Every symbol is capped by the leverage ceiling reported by the venue.
    // No symbol may force TARGET_LEVERAGE above that ceiling.
    const lev = effectiveLeverage(s.max_leverage as number | null);
    const prev = leverageBySymbol.get(s.symbol);
    if (prev === undefined || lev > prev) leverageBySymbol.set(s.symbol, lev);
    if (!tickBySymbol.has(s.symbol)) tickBySymbol.set(s.symbol, s.tick_size == null ? null : Number(s.tick_size));
  }

  // 3. Fetch candles for enabled symbols in parallel. Any fetch failure only
  //    skips that symbol; others still process. Also process any symbols that
  //    still have open positions (even if disabled) so they can close out.
  const symbolsToProcess = new Set<string>(enabledSymbols.map((s) => s.symbol));
  for (const p of pRes.data ?? []) symbolsToProcess.add(p.symbol);

  // Bounded market-data fetch (Phase 4A wire-through). A slow ApeX endpoint
  // can no longer stall a single user's tick past MARKET_FETCH_TIMEOUT_MS;
  // the outer per-user try/catch in the cron path guarantees other users
  // remain isolated even if every symbol here times out. Provider selection
  // and completed-candle semantics are unchanged (see market.ts).
  const feeds = await Promise.all(
    Array.from(symbolsToProcess).map(async (sym) => {
      const tick = tickBySymbol.get(sym) ?? undefined;
      const [execution, setup1h, setup4h, setup1d] = await Promise.all([
        fetchCandlesBounded(sym, INTERVAL_MIN, FETCH_LIMIT, tick ?? undefined),
        fetchCandlesBounded(sym, SETUP_INTERVAL_1H_MIN, FETCH_LIMIT, tick ?? undefined),
        fetchCandlesBounded(sym, SETUP_INTERVAL_4H_MIN, FETCH_LIMIT, tick ?? undefined),
        fetchCandlesBounded(sym, 1440, FETCH_LIMIT, tick ?? undefined),
      ]);
      return {
        sym,
        feed: execution.ok ? execution.feed : null,
        setup1h: setup1h.ok ? setup1h.feed : null,
        setup4h: setup4h.ok ? setup4h.feed : null,
        setup1d: setup1d.ok ? setup1d.feed : null,
        error: execution.ok ? null : execution.reason,
      };
    }),
  );

  // Newest close per symbol — used for mark-to-market and heat/liq checks.
  const newestPxBySymbol = new Map<string, number>();
  for (const f of feeds) {
    if (!f.feed) continue;
    const cs = f.feed.candles;
    if (!cs.length) continue;
    newestPxBySymbol.set(f.sym, cs[cs.length - 1][CLOSE]);
  }

  // Portfolio marks (used by heat cap + account-wide liquidation check).
  const markPortfolio = () => {
    let unrealized = 0;
    let notional = 0;
    let usedMargin = 0;
    for (const pos of openBySlot.values()) {
      const px = newestPxBySymbol.get(pos.symbol);
      if (px == null) continue;
      const qty = Number(pos.size_qty);
      const entry = Number(pos.entry_price);
      const dirSign = pos.direction === "long" ? 1 : -1;
      unrealized += (px - entry) * qty * dirSign;
      notional += Math.abs(qty * px);
      usedMargin += Number(pos.margin);
    }
    const equity = accountBalance + unrealized;
    return { unrealized, notional, usedMargin, equity, freeMargin: equity - usedMargin };
  };

  // Account-wide liquidation (cross margin, shared fate).
  {
    const m = markPortfolio();
    if (m.notional > 0 && m.equity <= MMR * m.notional) {
      // Force-close every open position at newest close; net PnL flows into balance.
      // Each position is closed via atomic `paper_close_position` RPC — status
      // flip, trade insert, wallet stats bump, and paper_accounts delta happen
      // in one transaction. Idempotency: opKey keyed on position id + floor tag
      // so a raced/replayed liquidation tick cannot double-realize PnL.
      for (const [slotKey, pos] of Array.from(openBySlot.entries())) {
        const wk = pos.wallet_key;
        const px = newestPxBySymbol.get(pos.symbol);
        if (px == null) continue;
        const dirP = pos.direction as Direction;
        const dirSign = dirP === "long" ? 1 : -1;
        const qty = Number(pos.size_qty);
        const entry = Number(pos.entry_price);
        const exitPx = applySlip(px, dirP, false);
        const exitFee = exitPx * qty * FEE_RATE;
        const entryFee = Number(pos.entry_fee);
        const grossPnl = (exitPx - entry) * qty * dirSign;
        const netPnl = grossPnl - exitFee - entryFee;
        const trade = {
          wallet_key: wk, symbol: pos.symbol, direction: dirP,
          entry_price: entry, exit_price: exitPx, exit_reason: "floor",
          size_qty: qty, size_notional: Number(pos.size_notional),
          margin: Number(pos.margin), leverage: Number(pos.leverage),
          pnl_gross: grossPnl, fees: entryFee + exitFee,
          slippage_cost: Math.abs(exitPx - px) * qty, pnl_net: netPnl,
          hold_seconds: Math.max(1, Math.round((Date.now() - new Date(pos.entry_ts).getTime()) / 1000)),
          opened_at: pos.entry_ts, closed_at: new Date().toISOString(),
        };
        const wRow = walletsByKey.get(wk);
        const isWin = netPnl > 0;
        const opKey = `close:${pos.id}:floor`;
        const fp = await fingerprintPayload({ trade, delta: netPnl });
        const res = await repoClosePosition(supabase, {
          userId, positionId: pos.id, lastSeenCandleTsMs: null,
          trades: [trade] as unknown as Array<Record<string, unknown>>,
          accountDelta: netPnl,
          walletId: wRow?.id ?? null,
          walletStats: wRow ? { trades_delta: 1, wins_delta: isWin ? 1 : 0, losses_delta: isWin ? 0 : 1 } : null,
          opKey, fingerprint: fp,
        });
        if (res.result.ok) {
          const already = (res.result.value as { already_closed?: boolean })?.already_closed === true;
          if (!already) {
            accountBalance += netPnl;
            realizedDelta += netPnl;
            if (wRow) {
              walletsByKey.set(wk, {
                ...wRow, open_position_id: null,
                balance: Number(wRow.balance) + netPnl,
                realized_pnl: Number(wRow.realized_pnl ?? 0) + netPnl,
                trades_count: (wRow.trades_count ?? 0) + 1,
                wins_count: (wRow.wins_count ?? 0) + (isWin ? 1 : 0),
                losses_count: (wRow.losses_count ?? 0) + (isWin ? 0 : 1),
              } as typeof wRow);
            }
          }
        }
        openBySlot.delete(slotKey);
      }
      await emitBotEvent(supabase, userId, "ACCOUNT_LIQUIDATION", {
        equity: m.equity, notional: m.notional, mmr: MMR,
        starting_balance: startingAccountBalance,
        ending_balance: accountBalance,
      }, "error");
      // paper_accounts already updated by each repoClosePosition; short-circuit.
      return {
        ranAt: Date.now(),
        perSymbol: [],
        evaluations: [{
          symbol: "-" as PaperSymbol, direction: "long",
          outcome: "floor_hit", reason: "ACCOUNT LIQUIDATION (cross)",
          trend: null, trend_slope_pct: null, fresh_count: 0,
        }],
      };
    }
  }



  const perSymbol: TickResult["perSymbol"] = [];
  const evaluations: EvaluationDetail[] = [];
  const pushEval = (
    symbol: PaperSymbol, direction: Direction, outcome: EvalReason,
    reason: string, trend: TrendState | null, slope: number | null, freshCount: number,
  ) => {
    evaluations.push({
      symbol, direction, outcome, reason, trend, trend_slope_pct: slope, fresh_count: freshCount,
    });
  };

  // Phase A collection: per-tick candidate opens. The three armed-leg
  // branches below PROPOSE (not open) here; Phase B (Onyx) decides which
  // to deploy; Phase C actually inserts + updates wallets.
  const candidates: OnyxCandidate[] = [];
  interface CandidateExtras {
    walletId: string;
    walletBalance: number;
    walletRow: WalletRow;
    /** All ladder rungs (rung 1 is filled immediately at open). */
    rungs: Rung[];
    /** Margin committed per rung (constant). */
    marginPerRung: number;
  }
  const candidateExtras = new Map<string, CandidateExtras>();
  const candidateSelectionPath = new Map<string, SelectionPath>();
  const candidateDetector = new Map<string, StrategyLeg>();
  const candidatePlan = new Map<string, import("../automation/paperAuthorization").PaperPlanRoute>();
  const candidateExecutingTurtle = new Map<string, string>();
  const openedBySymbol = new Map<string, number>();
  interface SymbolCtx {
    newestTs: number;
    newestHigh: number;
    newestLow: number;
    newestClose: number;
    regime: Regime | null;
    trendState: TrendState | null;
    trendSlopePct: number | null;
    /** HTF (1h) BOS — Phase 1 telemetry only, no gate/exit/TP consumer. */
    htfBosState: "bullish_bos" | "bearish_bos" | "none";
    htfBosConfirmedAt: number | null;
    htfBosBarsSince: number | null;
    /**
     * Higher-timeframe context handed to the AI committee as part of the
     * immutable evidence snapshot. Advisory input only — these carry no
     * gating authority here; 4h remains the sweep leg's direction filter
     * and 1h remains telemetry, exactly as before.
     */
    htf4hBosState: "bullish_bos" | "bearish_bos" | "none";
    htf1dBosState: "bullish_bos" | "bearish_bos" | "none";
    htf1dLastClosedTs: number | null;
    htf4hLastClosedTs: number | null;
    htf1hLastClosedTs: number | null;
    htf15mLastClosedTs: number | null;
    marketEvidence: {
      atrPct: number | null;
      recentCloses: number[];
      recentHighs: number[];
      recentLows: number[];
      recentVolumes: number[];
    };
  }
  const symbolCtx = new Map<string, SymbolCtx>();

  // Ranking score for Onyx deterministic sort: TP:stop distance ratio.
  const rankScore = (fillPx: number, stopLevel: number, tpLevel: number): number => {
    const sd = Math.abs(fillPx - stopLevel);
    const td = Math.abs(tpLevel - fillPx);
    if (sd <= 0) return 0;
    return (td / sd) * 100;
  };

  /**
   * Ladder-based sizing shared across all legs. Reserves the FULL ladder up
   * front (candidate.margin / candidate.notional) so Phase C's free-margin +
   * heat-cap check gates the whole ladder, never just rung 1. `entryFee` is
   * rung 1's maker fee — the fee actually stored on the position at open.
   * `stopLevel` = deepest rung price (hard stop beyond last rung).
   * `tpLevel` = rung 1's PER-LOT tp (DCA_RUNG_TP_PCT away). Additional
   * per-lot tps live on each rung and are refreshed as new rungs fill.
   */
  const sizeLadder = (
    direction: Direction,
    signalPx: number,
    atr: number | null | undefined,
    lev: number,
    symbol: string,
    leg?: StrategyLeg | null,
    sniperStop?: number,
    availableEquity?: number,
  ) => {
    const regime = regimeBySymbol.get(symbol) ?? "unknown";
    const plan = planFormation({
      regime,
      leverage: lev,
      symbol,
      settledWalletBalance: Number(availableEquity ?? 0),
    });
    // WAIT regimes (reversal_forming, opposing_to_open_position) do NOT
    // authorize a new entry. Callers MUST invoke evaluateEntryAuthorization
    // BEFORE this function and skip the candidate when it returns
    // authorized:false. Reaching this branch means a caller bypassed the
    // guard — throw to force the bug into the light rather than silently
    // creating a legacy-geometry ladder for a forbidden regime.
    if (plan.mode === "wait") {
      throw new Error(
        `sizeLadder invoked with wait plan (regime=${plan.regime}); ` +
        `caller must invoke evaluateEntryAuthorization first`,
      );
    }
    const settledWalletBalance = Number(availableEquity ?? 0);
    const isZenSweep = leg === "sweep" && CANONICAL_SCAN_SYMBOL_SET.has(symbol);
    if (isZenSweep) {
      const rungs = buildZenSweepLadder({
        direction,
        alertPrice: signalPx,
        leverage: lev,
        availableEquity: Number(availableEquity ?? 0),
      });
      if (rungs.length !== ZEN_SWEEP.execution.rung_count) {
        throw new Error("zen_sweep_v1 sizing failed closed");
      }
      const marginPerRung = rungs[0].margin;
      const rung1 = rungs[0];
      const totalMargin = marginPerRung * rungs.length;
      return {
        rungs,
        marginPerRung,
        rung1,
        fillPx: rung1.price,
        initialQty: rung1.qty,
        initialNotional: rung1.qty * rung1.price,
        initialFee: rung1.price * rung1.qty * MAKER_FEE_RATE,
        totalMargin,
        totalNotional: ladderNotional(rungs),
        totalQty: ladderQty(rungs),
        stopLevel: deepestRungPrice(rungs, direction),
        tpLevel: rung1.tp,
        plan,
      };
    }

    // Strategy selection never owns sizing. Every new campaign, regardless
    // of detector, uses the destination wallet's universal 5% / five-rung
    // contract. The campaign amount is frozen in the persisted rung data.
    const { sizing, rungs } = buildWalletCampaignLadder({
      direction,
      signalPrice: signalPx,
      atr: atr ?? null,
      leverage: lev,
      settledWalletBalance,
    });
    if (rungs.length !== WALLET_CAMPAIGN_RUNG_COUNT) {
      throw new Error("wallet campaign sizing failed closed");
    }
    const marginPerRung = sizing.marginPerRung;
    const isSniper = leg === "sniper";
    if (isSniper && sniperStop != null) {
      // Seed each planned lot's TP from the R-multiple sweep target computed
      // at the cumulative average price through that rung.
      let cumNotional = 0, cumQty = 0;
      for (const r of rungs) {
        cumNotional += r.qty * r.price;
        cumQty += r.qty;
        const avg = cumQty > 0 ? cumNotional / cumQty : r.price;
        r.tp = sweepTpPrice(avg, sniperStop, direction);
      }
    }

    // Retain SNIPER_MAX_RUNGS + sniperTpPrice imports for legacy manage
    // paths on already-open positions until they are purged.
    void SNIPER_MAX_RUNGS; void sniperTpPrice;



    const rung1 = rungs[0];
    const fillPx = rung1.price;
    const initialQty = rung1.qty;
    const initialNotional = initialQty * fillPx;
    const initialFee = fillPx * initialQty * MAKER_FEE_RATE;
    const totalMargin = sizing.committedMargin;
    const totalNotional = ladderNotional(rungs);
    const totalQty = ladderQty(rungs);
    const stopLevel = deepestRungPrice(rungs, direction);
    const tpLevel = rung1.tp;
    return { rungs, marginPerRung, rung1, fillPx, initialQty, initialNotional,
      initialFee, totalMargin, totalNotional, totalQty, stopLevel, tpLevel, plan };
  };


  const serializeRung = (r: Rung): Rung => ({
    price: r.price,
    qty: r.qty,
    margin: r.margin,
    tp: r.tp,
  });

  const serializeRungs = (rungs: readonly Rung[]): Rung[] => rungs.map(serializeRung);




  for (const { sym, feed, setup1h, setup4h, setup1d, error } of feeds) {
    if (!feed) { perSymbol.push({ symbol: sym, newestCandleTs: null, opened: 0, closed: 0, error: error ?? "unknown fetch error" }); continue; }
    const candles = feed.candles;
    if (!candles.length) { perSymbol.push({ symbol: sym, newestCandleTs: null, opened: 0, closed: 0, error: "no candles" }); continue; }
    const newest = candles[candles.length - 1];
    const newestTs = newest[TS];
    let opened = 0, closed = 0;
    let blockedLong = 0, blockedShort = 0;

    // Pre-compute swings + evaluations for both directions (used by open/close paths).
    const atrAt = wilderAtrSeries(candles);
    const rawSwings = findConfirmedSwings(candles);
    const swings = groupLiquidityZones(rawSwings, atrAt, feed.tick);
    const evalByDir: Record<Direction, ReturnType<typeof evaluate>> = {
      long: evaluate(candles, "long", feed.tick),
      short: evaluate(candles, "short", feed.tick),
    };

    // Scout trend state for this symbol on this tick. Same input candles the
    // engine already fetched — no extra I/O. Used to gate NEW entries only;
    // OPEN positions manage themselves to structural exits regardless of trend.
    const trend: TrendInfo = computeTrend(candles);

    // Regime classification: which regime this symbol is in and which leg
    // (accumulator | sniper | hunter | null) the router arms. Per (sym,dir):
    //   - trend    → accumulator (break-and-retest)
    //   - neutral  → sniper      (VWAP-target fakeout)
    //   - high_vol → hunter      (volatility-gated FVG)
    //   - null     → no leg armed; the tick sits out with a `no_regime`
    //                evaluation for this (sym,dir). Regime-based routing is
    //                the sole per-tick router; there is no time-slot rotation.
    const _regimeInfo = classifyRegime(candles);
    const regime: Regime | null = _regimeInfo.regime;
    // Trend split: fresh trend (age <= TREND_FRESH_MAX_CANDLES) → vanguard;
    // aged trend → accumulator. Non-trend regimes ignore trend_age. See
    // routing.ts and shared/mainnet_parity_constants.json.regime_routing.
    const armedLeg: StrategyLeg | null = legForRegime(regime, _regimeInfo.trendAgeCandles);

    // Native 1h and 4h setup feeds qualify NEW 15m entries. They are fetched
    // independently so a 15m history window can never masquerade as adequate
    // higher-timeframe history. Open-position management remains on 15m and
    // does not depend on either setup feed being available.
    const htf1h = setup1h?.candles ?? [];
    const htfBos = detectHtfBos(htf1h, feed.tick);
    const htf4h = setup4h?.candles ?? [];
    const htf4hBos = detectHtfBos(htf4h, feed.tick);
    const htf1d = setup1d?.candles ?? [];
    const htf1dBos = detectHtfBos(htf1d, feed.tick);
    const evidenceCandles = candles.slice(-32);
    const latestAtr = atrAt[atrAt.length - 1] ?? null;

    symbolCtx.set(sym, {
      newestTs, newestHigh: newest[HIGH], newestLow: newest[LOW], newestClose: newest[CLOSE],
      regime, trendState: trend.state, trendSlopePct: trend.slopePct,
      htfBosState: htfBos.state,
      htfBosConfirmedAt: htfBos.confirmedAtTs,
      htfBosBarsSince: htfBos.barsSinceConfirm,
      htf4hBosState: htf4hBos.state,
      htf1dBosState: htf1dBos.state,
      htf1dLastClosedTs: htf1d.length ? Number(htf1d[htf1d.length - 1]![TS]) : null,
      htf4hLastClosedTs: htf4h.length ? Number(htf4h[htf4h.length - 1]![TS]) : null,
      htf1hLastClosedTs: htf1h.length ? Number(htf1h[htf1h.length - 1]![TS]) : null,
      htf15mLastClosedTs: newestTs,
      marketEvidence: {
        atrPct: latestAtr != null && newest[CLOSE] > 0 ? (latestAtr / newest[CLOSE]) * 100 : null,
        recentCloses: evidenceCandles.map((c) => c[CLOSE]),
        recentHighs: evidenceCandles.map((c) => c[HIGH]),
        recentLows: evidenceCandles.map((c) => c[LOW]),
        recentVolumes: evidenceCandles.map((c) => c[VOLUME]),
      },
    });
    // Hunter inputs — volatility-gated FVGs (K from backtest_pnl_hunter.py)
    // and hunter's own 5-candle strict swings for exit targets. Reused across
    // directions and by the hunter manage path.
    const hunterFvgs: Fvg[] = findFvgs(candles, HUNTER_K_THRESHOLD);
    const hunterSwings: HunterSwing[] = findHunterSwings(candles);
    const newestIdx = candles.length - 1;

    // First opposing swing after entry index, on the profitable side.
    const nextOpposingHunterSwing = (
      dirLocal: Direction, entryIdx: number, entryPx: number,
    ): HunterSwing | null => {
      const favKind: HunterSwing["kind"] = dirLocal === "long" ? "high" : "low";
      for (const s of hunterSwings) {
        if (s.index <= entryIdx) continue;
        if (s.kind !== favKind) continue;
        if (dirLocal === "long" && s.level > entryPx) return s;
        if (dirLocal === "short" && s.level < entryPx) return s;
      }
      return null;
    };

    for (const dir of ["long", "short"] as Direction[]) {
      const coreWalletKey = walletKey(sym, dir);
      // Role wallets are no longer symbol-specific. A Strategy position must
      // be managed by the same exit machinery as a core position, and a Hedge
      // position must be managed on its own opposite-direction pass. At most
      // one matching position can exist for this direction because the DB
      // serializes symbol opens and permits Hedge only opposite an open core.
      const open = ([coreWalletKey, "strategy", "hedge"] as const)
        .map((role) => openBySlot.get(campaignSlotKey(role, sym)))
        .find((position) => position?.direction === dir);
      const wk = open?.wallet_key ?? coreWalletKey;
      const wallet = walletsByKey.get(wk);
      if (!wallet) {
        pushEval(sym, dir, "wallet_missing", "no wallet row for key", trend.state, trend.slopePct, 0);
        continue;
      }
      const slotKey = campaignSlotKey(wk, sym);

      // ---- Manage open position ----
      if (open) {
        pushEval(sym, dir, "position_open", `open position ${open.id}`, trend.state, trend.slopePct, 0);
        // If we've already processed this newest candle for this position, skip.
        if (open.last_seen_candle_ts_ms && Number(open.last_seen_candle_ts_ms) >= newestTs) continue;

        // ── UNIFIED PARTIAL-REDUCE LADDER MANAGE (all strategies) ──────────
        // Symmetric per-rung TP ladder. Each filled lot has its own TP
        // (DCA_RUNG_TP_PCT above/below its own fill). When a lot's TP is
        // touched by the candle high (long) / low (short), we PARTIALLY
        // CLOSE just that lot: realize its PnL into the shared cross
        // account and remove it from fills[]. Other lots stay open.
        // The position is fully closed only when (a) all lots have scaled
        // out, (b) hard stop past the deepest rung fires (candle CLOSE
        // beyond rung 4), or (c) account-wide cross liquidation.
        type Lot = { price: number; qty: number; margin: number; tp: number };
        type StrategyMetadata = {
          contract_id?: string;
          first_target_taken?: boolean;
          banked_net_pnl?: number;
          high_water_net_roi_pct?: number;
          trailing_floor_net_roi_pct?: number | null;
        };
        const dirSign: number = dir === "long" ? 1 : -1;
        const isZenSweepPosition = open.strategy === "sweep"
          && CANONICAL_SCAN_SYMBOL_SET.has(open.symbol);
        const strategyMetadata = {
          ...(open.strategy_metadata && typeof open.strategy_metadata === "object"
            ? open.strategy_metadata
            : {}),
        } as StrategyMetadata;
        const lev = Number(open.leverage) || TARGET_LEVERAGE;
        const hi = newest[HIGH], lo = newest[LOW], cl = newest[CLOSE];
        // Once armed, the campaign stop survives partial exits. Legacy stops
        // are reconstructed from cumulative fills, never remaining lots.

        // Hydrate the campaign exactly as it was frozen at creation. Explicit
        // stored margin and quantity must never be normalized to today's
        // wallet balance or to a legacy fixed-dollar rung size.
        const backfillTp = (p: number) =>
          dir === "long" ? p * (1 + DCA_RUNG_TP_PCT) : p * (1 - DCA_RUNG_TP_PCT);
        type RawLot = { price: number; qty?: number; margin?: number; tp?: number };
        const levForRungs = Number(open.leverage) || TARGET_LEVERAGE;
        const rawFills: RawLot[] = Array.isArray(open.fills)
          ? (open.fills as unknown as RawLot[]) : [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawPending: RawLot[] = Array.isArray((open as any).pending_rungs)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? ((open as any).pending_rungs as RawLot[]) : [];
        const rawResize = Array.isArray(open.resize_levels)
          ? (open.resize_levels as unknown as Array<RawLot | number>) : [];
        const storedPlannedRungs = Number(open.ladder_total_rungs);
        const plannedRungCount = storedPlannedRungs > 0
          ? Math.floor(storedPlannedRungs)
          : Math.max(1, rawFills.length + rawPending.length);
        const storedTotalMargin = Number(open.ladder_total_margin ?? open.margin);
        const marginPerRungForOpen = storedTotalMargin > 0
          ? storedTotalMargin / plannedRungCount
          : dcaMarginPerRungForLeverage(levForRungs);
        const hydrateRung = (r: RawLot): Rung | null => {
          const price = Number(r.price);
          if (!(price > 0)) return null;
          const rawMargin = Number(r.margin);
          const margin = rawMargin > 0 ? rawMargin : marginPerRungForOpen;
          const rawQty = Number(r.qty);
          const qty = rawQty > 0 ? rawQty : (margin * levForRungs) / price;
          if (!(qty > 0)) return null;
          return {
            price,
            qty,
            margin,
            tp: Number(r.tp ?? backfillTp(price)),
          };
        };
        // Fallback for legacy rows with no fills[] recorded — reconstruct a
        // single lot from the stored position aggregate.
        const lots: Lot[] = rawFills.length > 0
          ? rawFills.map(hydrateRung).filter((l): l is Rung => l != null)
          : [{
              price: Number(open.entry_price),
              qty: Number(open.size_qty),
              margin: Number(open.margin),
              tp: open.tp_level == null ? backfillTp(Number(open.entry_price)) : Number(open.tp_level),
            }];
        const needsRungNormalization = (r: RawLot | number): boolean => {
          if (typeof r !== "object" || r == null) return true;
          const price = Number(r.price);
          const qty = Number(r.qty);
          const margin = Number(r.margin);
          const tp = Number(r.tp);
          return !(price > 0) || !(qty > 0) || !(margin > 0) || !(tp > 0);
        };
        const resizePending = rawResize
          .filter((r): r is RawLot => typeof r === "object" && r != null)
          .map(hydrateRung)
          .filter((r): r is Rung => r != null);
        const pendingHydrated: Rung[] = (rawPending.length > 0 ? rawPending : resizePending)
          .map(hydrateRung)
          .filter((r): r is Rung => r != null);
        let rungCount = open.rung_count ?? lots.length;
        let repairedPendingLadder =
          rawFills.length === 0 ||
          rawFills.some(needsRungNormalization) ||
          rawPending.some(needsRungNormalization) ||
          rawResize.some(needsRungNormalization) ||
          rawPending.length !== pendingHydrated.length ||
          rawResize.length !== pendingHydrated.length;

        // ── HYDRATION FALLBACK — legacy rows where pending_rungs was never
        //    persisted (or was truncated) leave rungs 2..N un-placed. If the
        //    row still has capacity, rebuild the remaining rungs from the
        //    FIRST-FILL price so they can fill on this and subsequent ticks.
        //    Only fills that weren't already recorded are appended.
        const levForRebuild = levForRungs;
        const rebuildRungCount = storedPlannedRungs > 0
          ? Math.floor(storedPlannedRungs)
          : dcaRungsForLeverage(levForRebuild);
        if (
          pendingHydrated.length < Math.max(0, rebuildRungCount - rungCount) &&
          rungCount < rebuildRungCount &&
          lots.length > 0
        ) {
          const firstFill = Number(open.first_fill_vwap ?? open.entry_price ?? lots[0].price);
          if (firstFill > 0 && levForRebuild > 0) {
            const perRung = storedTotalMargin > 0
              ? storedTotalMargin / rebuildRungCount
              : dcaMarginPerRungForLeverage(levForRebuild);
            const rebuilt = buildLadder(dir, firstFill, null, levForRebuild, perRung, rebuildRungCount);
            const filledPrices = new Set(lots.map((l) => Number(l.price.toFixed(8))));
            for (const r of rebuilt) {
              if (filledPrices.has(Number(r.price.toFixed(8)))) continue;
              if (pendingHydrated.some((p) => Number(p.price.toFixed(8)) === Number(r.price.toFixed(8)))) continue;
              pendingHydrated.push(r);
            }
            repairedPendingLadder = true;
          }
        }


        // ── SCOUT GUARDIAN — cancel unfilled rungs. The always-on worker
        //    flagged this position's structure as breaking down. Void every
        //    pending rung so the ladder can no longer DCA deeper into the
        //    break, and arm the hard stop NOW at the current deepest fill
        //    instead of waiting for the full ladder to fill — the exact gap
        //    that let three positions ride to the hard stop. This is a
        //    protective metadata update (no balance/PnL mutation), so a direct
        //    write is safe.
        const guardianCancel = guardianCancelByPos.get(open.id);
        if (guardianCancel && pendingHydrated.length > 0) {
          const deepest = deepestRungPrice(lots, dir);
          const arm = armLadderHardStop(dir, lots.length, lots.length, deepest);
          const cancelUpd: Record<string, unknown> = {
            pending_rungs: [],
            resize_levels: [],
            ladder_total_rungs: lots.length,
            configured_rung_count: lots.length,
            last_seen_candle_ts_ms: newestTs,
          };
          if (arm.armed && arm.finalRungFillPrice != null) {
            cancelUpd.stop_level = arm.armedStopPrice;
            cancelUpd.hard_stop_armed_at = new Date().toISOString();
            cancelUpd.final_rung_fill_price = arm.finalRungFillPrice;
            cancelUpd.armed_stop_price = arm.armedStopPrice;
            cancelUpd.armed_reason = "scout_guardian_cancel";
            cancelUpd.ladder_contract_version = LADDER_CONTRACT_VERSION;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase.from("paper_positions") as any).update(cancelUpd).eq("id", open.id);
          await emitBotEvent(supabase, userId, "SCOUT_BOS", {
            position_id: open.id, symbol: sym, direction: dir,
            guardian: "cancel_unfilled_rungs",
            reason_code: guardianCancel.reasonCode,
            cancelled_pending: pendingHydrated.length,
            armed_stop: cancelUpd.stop_level ?? null,
          }, "warn");
          // Empty the pending set so nothing fills this tick, and reflect the
          // shrunk ladder in memory so THIS tick's exit block can arm/fire the
          // hard stop immediately (the reload picks it up on later ticks).
          pendingHydrated.length = 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (open as any).ladder_total_rungs = lots.length;
          await markDirectiveConsumed(guardianCancel.id);
        }

        // ── 1) PENDING RUNG FILLS — extend the position with any pending
        //      rungs the newest candle touched. Maker fills at rung price.
        const { filled: newlyFilled, stillPending } =
          pendingRungsHitByCandle(pendingHydrated, dir, lo, hi);
        for (const r of newlyFilled) {
          lots.push({ price: r.price, qty: r.qty, margin: r.margin, tp: r.tp });
          rungCount += 1;
        }
        // Onyx→Scout HANDOFF: any rung fill means Onyx is handing an updated
        // position to the Scout to guard.
        if (newlyFilled.length > 0) {
          await emitBotEvent(supabase, userId, "ONYX_HANDOFF", {
            position_id: open.id,
            symbol: sym,
            direction: dir,
            avg_entry: lots.reduce((s, l) => s + l.price * l.qty, 0) / Math.max(1e-12, lots.reduce((s, l) => s + l.qty, 0)),
            rungs_filled: rungCount,
            trigger: "rung_fill",
          });
        }

        // ── SCOUT DEFENSIVE WATCH — protective structural swing + BOS check.
        //   Long: most recent confirmed higher-low below mark; adverse BOS =
        //   5m close BELOW that swing level. Mirror for short. Reuses the
        //   same findConfirmedSwings + zone logic as the entry/stop.
        const protective = protectiveSwingForOpen(swings, dir, candles.length - 1, cl);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const alreadyBroken = Boolean((open as any).structure_broken);
        // Promoted runners IGNORE 5m adverse-BOS marking (the whole point of
        // HTF promotion: exit only on adverse 1h BOS or breakeven stop).
        const atrNow5m = atrAt[candles.length - 1];
        // Bare close-vs-level breach (pre-significance filter) — used to log
        // sub-threshold pokes so the min_displacement_atr floor can be tuned
        // from data. Owner-mandated telemetry (BOS SIGNIFICANCE pass).
        const bareBreach = protective
          ? (dir === "long" ? cl < protective.level : cl > protective.level)
          : false;
        const confirmedAdverseBos =
          !open.promoted && protective && !alreadyBroken &&
          isAdverseBos(dir, cl, protective.level, atrNow5m);
        if (confirmedAdverseBos) {
          // Mark broken; Onyx open-book review will convert this into a
          // scout_bos exit in Phase C (see decide.ts).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase.from("paper_positions") as any).update({
            structure_broken: true,
            structure_broken_ts_ms: newestTs,
            structure_broken_level: protective.level,
            protective_swing_level: protective.level,
            protective_swing_kind: protective.kind,
            last_seen_candle_ts_ms: newestTs,
          }).eq("id", open.id);
          await emitBotEvent(supabase, userId, "SCOUT_BOS", {
            position_id: open.id,
            symbol: sym,
            direction: dir,
            broken_level: protective.level,
            close: cl,
            pivot_ts: protective.pivot_ts,
          }, "warn");
          // Fall through to mechanical exits below — hard stop still wins if
          // both fire on the same candle. Otherwise Onyx will close via
          // scout_bos in Phase C.
        } else if (!open.promoted && protective && !alreadyBroken && bareBreach) {
          // Sub-threshold poke: bare close-vs-level breach that did NOT clear
          // BOS_MIN_DISPLACEMENT_ATR × ATR. Log so we can tune the floor.
          const disp = dir === "long" ? protective.level - cl : cl - protective.level;
          const atrVal = atrNow5m ?? 0;
          await emitBotEvent(supabase, userId, "SCOUT_BOS_REJECTED", {
            reason: "bos_below_significance",
            position_id: open.id,
            symbol: sym,
            direction: dir,
            close: cl,
            level: protective.level,
            displacement: disp,
            atr: atrVal,
            threshold: 0.25 * atrVal,
          }, "info");
        }
        if (protective && !confirmedAdverseBos) {
          // Track protective swing on the row so the dashboard can render it,
          // even when it hasn't broken. Only write if it drifted (cheap).
          const cur = Number(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (open as any).protective_swing_level ?? NaN,
          );
          if (!Number.isFinite(cur) || Math.abs(cur - protective.level) / Math.max(1e-12, protective.level) > 1e-6) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase.from("paper_positions") as any).update({
              protective_swing_level: protective.level,
              protective_swing_kind: protective.kind,
            }).eq("id", open.id);
          }
        }


        // ── HTF PROMOTION + RUNNER STATE ─────────────────────────────────
        // (Phase 3, no-bank owner ruling). Compute unrealized net PnL for the
        // whole position at the current close, then:
        //   (a) if not yet promoted and shouldPromote() is true → atomically
        //       persist the promotion patch (full size, breakeven stop, no
        //       TP, no pending rungs). Position becomes a runner THIS tick.
        //   (b) if already promoted → emit htf_runner_state telemetry, and
        //       compute runnerExit (adverse 1h BOS OR breakeven-stop hit).
        const computeUnrealizedNet = (): number => {
          let s = 0;
          for (const lot of lots) {
            const exitPx = applySlip(cl, dir, false);
            const exitFee = exitPx * lot.qty * FEE_RATE;
            const entryFeeLot = lot.price * lot.qty * MAKER_FEE_RATE;
            const gross = (exitPx - lot.price) * lot.qty * dirSign;
            s += gross - exitFee - entryFeeLot;
          }
          return s;
        };
        let runnerExit: "htf_bos_exit" | "runner_breakeven_stop" | null = null;
        if (!open.promoted && !isZenSweepPosition) {
          const unreal = computeUnrealizedNet();
          if (shouldPromote({
            isOpen: true,
            alreadyPromoted: false,
            unrealizedNetPnl: unreal,
            htfState: htfBos.state,
            direction: dir,
          })) {
            const entryVwap = Number(open.entry_price);
            const beStop = computeBreakevenStop(entryVwap, dir);
            const promoPatch: Record<string, unknown> = {
              promoted: true,
              promoted_at: new Date().toISOString(),
              runner_breakeven_stop: beStop,
              stop_level: beStop,
              tp_level: null,
              pending_rungs: [],
              resize_levels: [],
              last_seen_candle_ts_ms: newestTs,
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase.from("paper_positions") as any).update(promoPatch).eq("id", open.id);
            // Reflect in memory so downstream exit logic sees the runner.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (open as any).promoted = true;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (open as any).runner_breakeven_stop = beStop;
            await emitBotEvent(supabase, userId, "HTF_PROMOTION", {
              position_id: open.id,
              symbol: sym,
              direction: dir,
              entry_vwap: entryVwap,
              breakeven_stop: beStop,
              unrealized_net_pnl: unreal,
              htf_bos_state: htfBos.state,
              htf_bos_confirmed_at: htfBos.confirmedAtTs,
              bank_fraction: 0,
            });
          }
        }
        if (open.promoted) {
          const beStop = Number(open.runner_breakeven_stop) || 0;
          const distPct = beStop > 0 ? ((cl - beStop) / beStop) * (dir === "long" ? 1 : -1) : null;
          await emitBotEvent(supabase, userId, "htf_runner_state", {
            position_id: open.id,
            symbol: sym,
            direction: dir,
            close: cl,
            breakeven_stop: beStop,
            distance_to_stop_pct: distPct,
            unrealized_net_pnl: computeUnrealizedNet(),
            htf_bos_state: htfBos.state,
          });
          if (isAdverseHtfBos(dir, htfBos.state)) {
            runnerExit = "htf_bos_exit";
          } else if (runnerBreakevenStopHit(dir, cl, beStop)) {
            runnerExit = "runner_breakeven_stop";
          }
        }

        // ── EXIT DECISION ────────────────────────────────────────────────
        // Compute per-lot exits first (no DB writes yet). Hard stop wins
        // vs TP, but the strategy hard stop is ONLY armed once every planned
        // rung has filled — before that pending rungs are the planned
        // adverse-price actions, and only Scout BOS / cross-margin
        // liquidation / kill switch may force-close the position. See
        // `armedHardStopLevel` for the exact contract.
        const plannedRungTotal = Number(open.ladder_total_rungs)
          || dcaRungsForLeverage(lev);
        // The last rung is the deepest fill price. Under the leverage-tiered
        // ladder, `deepestRungPrice(lots, dir)` returns exactly rung N's
        // actual fill price (not the VWAP, not the initial signal).
        const lastRungFillPx = lots.length > 0 ? deepestRungPrice(lots, dir) : null;
        const armedStop = isZenSweepPosition
          ? Number(open.stop_level)
          : resolveCampaignHardStop({
              direction: dir,
              armedStopPrice: open.armed_stop_price,
              armedAt: open.hard_stop_armed_at,
              stopLevel: open.stop_level,
              finalRungFillPrice: open.final_rung_fill_price,
              filledRungCount: rungCount,
              totalPlannedRungs: plannedRungTotal,
              deepestOpenFillPrice: lastRungFillPx,
            });
        // Promoted runners: mechanical hard stop is the breakeven stop, not
        // the ladder-derived deep stop. Non-promoted: standard armed stop.
        const hardStop = open.promoted
          ? false // runner exits are handled via runnerExit above
          : (armedStop != null
              && ((dir === "long" && cl < armedStop) || (dir === "short" && cl > armedStop)));
        type ExitReason = "tp_touch" | "stop" | "scout_guardian_bos"
          | "scout_guardian_cluster" | "htf_bos_exit"
          | "runner_breakeven_stop" | "zen_tp1" | "zen_tp2" | "zen_trailing";
        type Exit = {
          /** Quantity/margin being closed. */
          lot: Lot;
          /** Original lot in the in-memory fill array. */
          sourceLot: Lot;
          /** Pro-rata remainder after a partial campaign exit. */
          remainingLot?: Lot;
          exitRaw: number;
          reason: ExitReason;
        };
        // SCOUT GUARDIAN force-close: the worker directed a full exit (adverse
        // BOS or a dying correlated cluster). Close every lot at the mark now,
        // before the position rides to the hard stop. A same-candle hard stop
        // still wins (it is the tighter mechanical protection).
        // Promoted runners IGNORE 5m adverse-BOS guardian closes
        // (scout_guardian_bos); the correlated-cluster rule still applies.
        const rawGuardianClose = guardianCloseByPos.get(open.id) ?? null;
        const guardianClose = (open.promoted && rawGuardianClose?.exitReason === "scout_guardian_bos")
          ? null
          : rawGuardianClose;
        const exits: Exit[] = [];
        const remaining: Lot[] = [];
        if (runnerExit) {
          for (const lot of lots) exits.push({ lot, sourceLot: lot, exitRaw: cl, reason: runnerExit });
        } else if (hardStop) {
          for (const lot of lots) exits.push({ lot, sourceLot: lot, exitRaw: cl, reason: "stop" });
        } else if (guardianClose) {
          for (const lot of lots) exits.push({ lot, sourceLot: lot, exitRaw: cl, reason: guardianClose.exitReason });
        } else if (isZenSweepPosition) {
          const openNetPnl = computeUnrealizedNet();
          const initialMargin = Number(open.ladder_total_margin ?? open.margin);
          const zenExit = decideZenSweepExit({
            bankedNetPnl: Number(strategyMetadata.banked_net_pnl ?? 0),
            openNetPnl,
            initialMargin,
            firstTargetTaken: strategyMetadata.first_target_taken === true,
            previousHighWaterRoiPct: strategyMetadata.high_water_net_roi_pct,
          });
          strategyMetadata.contract_id = ZEN_SWEEP.strategy_id;
          strategyMetadata.high_water_net_roi_pct = zenExit.highWaterRoiPct;
          strategyMetadata.trailing_floor_net_roi_pct = zenExit.trailingFloorRoiPct;

          if (zenExit.action === "close_half") {
            for (const sourceLot of lots) {
              const lot = {
                ...sourceLot,
                qty: sourceLot.qty * ZEN_SWEEP.exit.first_close_fraction,
                margin: sourceLot.margin * ZEN_SWEEP.exit.first_close_fraction,
              };
              const remainingLot = {
                ...sourceLot,
                qty: sourceLot.qty - lot.qty,
                margin: sourceLot.margin - lot.margin,
              };
              exits.push({ lot, sourceLot, remainingLot, exitRaw: cl, reason: "zen_tp1" });
              remaining.push(remainingLot);
            }
          } else if (zenExit.action === "close_all_target" || zenExit.action === "close_all_trailing") {
            const reason = zenExit.action === "close_all_target" ? "zen_tp2" : "zen_trailing";
            for (const lot of lots) exits.push({ lot, sourceLot: lot, exitRaw: cl, reason });
          } else {
            remaining.push(...lots);
          }
        } else {
          // FIX 1 (TP mismatch): honor position.tp_level alongside lot.tp
          // via the shared `effectiveTp` helper (nearer target wins for the
          // position direction). See src/lib/paper/effectiveTp.ts.
          for (const lot of lots) {
            const effTp = effectiveTp(dir, lot.tp, open.tp_level as number | null);
            const touched = dir === "long" ? hi >= effTp : lo <= effTp;
            if (touched) exits.push({ lot, sourceLot: lot, exitRaw: effTp, reason: "tp_touch" });
            else remaining.push(lot);
          }
        }

        const buildTradeForExit = (e: Exit) => {
          const exitPx = applySlip(e.exitRaw, dir, false);
          const exitFee = exitPx * e.lot.qty * FEE_RATE;
          const entryFeeLot = e.lot.price * e.lot.qty * MAKER_FEE_RATE;
          const grossPnl = (exitPx - e.lot.price) * e.lot.qty * dirSign;
          const netPnl = grossPnl - exitFee - entryFeeLot;
          const closedAtMs = newestTs + INTERVAL_MIN * 60_000;
          const openedAtMs = new Date(open.entry_ts).getTime();
          return {
            trade: {
              wallet_key: wk, symbol: sym, direction: dir,
              entry_price: e.lot.price, exit_price: exitPx, exit_reason: e.reason,
              size_qty: e.lot.qty, size_notional: e.lot.qty * e.lot.price,
              margin: e.lot.margin, leverage: lev,
              pnl_gross: grossPnl, fees: entryFeeLot + exitFee,
              slippage_cost: Math.abs(exitPx - e.exitRaw) * e.lot.qty,
              pnl_net: netPnl,
              hold_seconds: Math.max(1, Math.round((closedAtMs - openedAtMs) / 1000)),
              opened_at: open.entry_ts,
              closed_at: new Date(closedAtMs).toISOString(),
            },
            netPnl,
            isWin: netPnl > 0,
          };
        };

        // ── STEP A: If pending rungs filled AND we're keeping the position
        //   open (not hard-stopping, not TP-closing all lots this candle),
        //   persist the new fills atomically via `paper_add_rung`. CAS on
        //   rung_count prevents double-application on replay.
        if (newlyFilled.length > 0 && !hardStop && remaining.length > 0) {
          const totalQty = lots.reduce((s, l) => s + l.qty, 0);
          const totalNotional = lots.reduce((s, l) => s + l.qty * l.price, 0);
          const totalMargin = Number(open.ladder_total_margin ?? open.margin) || lots.reduce((s, l) => s + l.margin, 0);
          const totalEntryFee = lots.reduce((s, l) => s + l.price * l.qty * MAKER_FEE_RATE, 0);
          const avgEntry = totalQty > 0 ? totalNotional / totalQty : Number(open.entry_price);
          // SNIPER PROFILE: on rung fill, recompute the sniper early-TP from
          // the NEW avg entry and rewrite every lot's per-lot tp to that
          // single target. Both filled lots then exit at ONE recomputed TP
          // instead of drifting to their build-time avg-through-rung targets.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((open as any).strategy === "sniper") {
            const atrNowForSniper = atrAt[candles.length - 1];
            const newSniperTp = sniperTpPrice(avgEntry, dir, atrNowForSniper ?? null);
            for (const l of lots) l.tp = newSniperTp;
          }
          // FIX 1 (TP mismatch): vanguard/accumulator legs use the STRATEGY
          // target (open.tp_level) as the single source of truth for TP.
          // After every re-average, force each lot's per-lot tp to match
          // tp_level so the ladder-derived tp cannot drift away from the
          // structural target shown to the user and honored by the exit loop.
          // Sniper is handled above (per-rung recompute is intentional).
          // Hunter keeps its per-rung TP by design (FVG rungs have distinct
          // targets and are documented in hunter.ts).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const _strat = (open as any).strategy;
          if (_strat === "vanguard" || _strat === "accumulator") {
            const tpLraw = Number(open.tp_level);
            if (Number.isFinite(tpLraw) && tpLraw > 0) {
              for (const l of lots) l.tp = tpLraw;
            }
          }
          const nextTp = lots.map((l) => l.tp).reduce(
            (best, tp) => dir === "long" ? Math.min(best, tp) : Math.max(best, tp),
            dir === "long" ? Infinity : -Infinity,
          );
          // Arm the strategy hard stop ONLY on the tick that completes the
          // ladder. Uses the actual rung-N fill price, not the initial entry
          // and not the VWAP. Idempotent under retries: the CAS on rung_count
          // guarantees a single commit, and the arming payload is
          // deterministic so any retry overwrites with the same values.
          const armDecision = armLadderHardStop(
            dir, rungCount, plannedRungTotal, lastRungFillPx,
          );
          const newState: Record<string, unknown> = {
            entry_price: avgEntry,
            size_qty: totalQty,
            size_notional: totalNotional,
            margin: totalMargin,
            entry_fee: totalEntryFee,
            rung_count: rungCount,
            tp_level: Number.isFinite(nextTp) ? nextTp : open.tp_level,
            fills: serializeRungs(lots),
            resize_levels: serializeRungs(stillPending),
            pending_rungs: serializeRungs(stillPending),
            last_seen_candle_ts_ms: newestTs,
          };
          if (armDecision.armed && armDecision.finalRungFillPrice != null) {
            // Persist the arming audit alongside the rung update. The RPC
            // reads _new_state.armed and writes hard_stop_armed_at,
            // final_rung_fill_price, armed_stop_price, ladder_contract_version,
            // armed_reason, and stop_level in the same transaction.
            newState.stop_level = armDecision.armedStopPrice;
            newState.armed = buildArmingPayload(
              dir, armDecision.finalRungFillPrice, newestTs,
            );
          }

          const opKey = `addrung:${open.id}:${newestTs}:${rungCount}`;
          const fp = await fingerprintPayload(newState);
          // Assign deterministic rung_index for each newly filled rung.
          // Rung 1 = initial fill (recorded at open); subsequent rungs are
          // indexed by their sequential arrival order relative to the CAS
          // baseline. The DB unique key (position_id, rung_index) makes the
          // insert idempotent under retries and concurrent duplicates.
          const rungFills = newlyFilled.map((r, i) => ({
            rung_index: (rungCount - newlyFilled.length) + i + 1,
            price: r.price,
            qty: r.qty,
            margin: r.margin,
            tp: r.tp,
            fill_status: "filled" as const,
            candle_ts_ms: newestTs,
          }));
          const addRes = await repoAddRung(supabase, {
            userId, positionId: open.id,
            expectedRungCount: rungCount - newlyFilled.length,
            newState: newState as unknown as Record<string, unknown>,
            rungFills,
            opKey, fingerprint: fp,
          });
          if (!addRes.result.ok) continue;
        }

        // ── STEP B: Exits ────────────────────────────────────────────────
        if (exits.length === 0) {
          // No exits, no fills → metadata-only cursor bump / pending-ladder
          // repair. This is not a financial mutation so a direct update is safe.
          if (newlyFilled.length === 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase.from("paper_positions") as any).update({
              ...(repairedPendingLadder ? {
                fills: serializeRungs(lots),
                resize_levels: serializeRungs(stillPending),
                pending_rungs: serializeRungs(stillPending),
              } : {}),
              last_seen_candle_ts_ms: newestTs,
              ...(isZenSweepPosition ? { strategy_metadata: strategyMetadata } : {}),
            }).eq("id", open.id);
          }
          continue;
        }

        const built = exits.map(buildTradeForExit);
        const totalNet = built.reduce((s, b) => s + b.netPnl, 0);
        const wins = built.filter((b) => b.isWin).length;
        const losses = built.length - wins;
        const wRow0 = walletsByKey.get(wk) ?? wallet;

        if (remaining.length === 0) {
          // ALL lots exit → single atomic `paper_close_position`. Combines
          // status flip, N trade inserts, wallet stats bump, and cross-account
          // delta into one transaction. Idempotent via opKey.
          const reason = runnerExit ?? (hardStop ? "stop" : (guardianClose ? guardianClose.exitReason : "tp_all"));
          const opKey = `close:${open.id}:${reason}:${newestTs}`;
          const fp = await fingerprintPayload({ trades: built.map((b) => b.trade), delta: totalNet });
          const res = await repoClosePosition(supabase, {
            userId, positionId: open.id, lastSeenCandleTsMs: newestTs,
            trades: built.map((b) => b.trade) as unknown as Array<Record<string, unknown>>,
            accountDelta: totalNet,
            walletId: wRow0.id,
            walletStats: { trades_delta: built.length, wins_delta: wins, losses_delta: losses },
            opKey, fingerprint: fp,
          });
          if (res.result.ok) {
            const already = (res.result.value as { already_closed?: boolean })?.already_closed === true;
            if (!already) {
              accountBalance += totalNet; realizedDelta += totalNet;
              closed += built.length;
              walletsByKey.set(wk, {
                ...wRow0, open_position_id: null,
                balance: Number(wRow0.balance) + totalNet,
                realized_pnl: Number(wRow0.realized_pnl ?? 0) + totalNet,
                trades_count: (wRow0.trades_count ?? 0) + built.length,
                wins_count: (wRow0.wins_count ?? 0) + wins,
                losses_count: (wRow0.losses_count ?? 0) + losses,
              } as typeof wRow0);
            }
            // The Guardian-directed close has been applied — retire the
            // directive so it is not re-enforced on a later tick.
            if (guardianClose) await markDirectiveConsumed(guardianClose.id);
            openBySlot.delete(slotKey);
          }
          continue;
        }

        // Commit every partial-exit lot, the remaining position and its
        // target bookkeeping together. A failed lot must roll back the
        // entire reduction; otherwise a retry can halve an earlier lot twice.
        {
          const rQty = remaining.reduce((sum, lot) => sum + lot.qty, 0);
          const rNotional = remaining.reduce((sum, lot) => sum + lot.qty * lot.price, 0);
          const rMargin = remaining.reduce((sum, lot) => sum + lot.margin, 0);
          const rEntryFee = remaining.reduce((sum, lot) => sum + lot.price * lot.qty * MAKER_FEE_RATE, 0);
          const rNextTp = remaining.map((lot) => lot.tp).reduce(
            (best, tp) => dir === "long" ? Math.min(best, tp) : Math.max(best, tp),
            dir === "long" ? Infinity : -Infinity,
          );
          const net = built.reduce((sum, exit) => sum + exit.netPnl, 0);
          const wins = built.filter((exit) => exit.isWin).length;
          const newState = {
            entry_price: rQty > 0 ? rNotional / rQty : Number(open.entry_price),
            size_qty: rQty,
            size_notional: rNotional,
            margin: rMargin,
            entry_fee: rEntryFee,
            rung_count: rungCount,
            tp_level: Number.isFinite(rNextTp) ? rNextTp : open.tp_level,
            fills: serializeRungs(remaining),
            resize_levels: serializeRungs(stillPending),
            pending_rungs: serializeRungs(stillPending),
            last_seen_candle_ts_ms: newestTs,
            ...(isZenSweepPosition ? {
              strategy_metadata: {
                ...strategyMetadata,
                first_target_taken: strategyMetadata.first_target_taken === true
                  || exits.some((exit) => exit.reason === "zen_tp1"),
                banked_net_pnl: Number(strategyMetadata.banked_net_pnl ?? 0) + net,
              },
            } : {}),
          };
          const trades = built.map((exit) => exit.trade as unknown as Record<string, unknown>);
          const opKey = `reduce:${open.id}:${newestTs}:batch`;
          const fp = await fingerprintPayload({ trades, newState, delta: net });
          const res = await repoReducePosition(supabase, {
            userId, positionId: open.id, expectedRungCount: rungCount,
            trade: trades, newState, accountDelta: net, walletId: wRow0.id,
            walletStats: {
              trades_delta: built.length, wins_delta: wins,
              losses_delta: built.length - wins,
            },
            opKey, fingerprint: fp,
          });
          if (res.result.ok) {
            accountBalance += net;
            realizedDelta += net;
            closed += built.length;
            const curW = walletsByKey.get(wk) ?? wRow0;
            walletsByKey.set(wk, {
              ...curW,
              balance: Number(curW.balance) + net,
              realized_pnl: Number(curW.realized_pnl ?? 0) + net,
              trades_count: (curW.trades_count ?? 0) + built.length,
              wins_count: (curW.wins_count ?? 0) + wins,
              losses_count: (curW.losses_count ?? 0) + built.length - wins,
            } as typeof curW);
          }
          continue;
        }
      }



      // ---- Open new position (if a newly-closed candle produced a fresh
      //      confirmed entry we haven't processed yet) ----
      if (!symbolsToProcess.has(sym) || !enabledSymbols.some((s) => s.symbol === sym)) {
        pushEval(sym, dir, "symbol_disabled", "symbol not enabled for entries", trend.state, trend.slopePct, 0);
        continue;
      }

      const setupDecision = evaluateSetupTimeframes({
        direction: dir,
        oneHourAvailable: htf1h.length > 0,
        fourHourAvailable: htf4h.length > 0,
        oneHourBos: htfBos.state,
        fourHourBos: htf4hBos.state,
        executionTsMs: newestTs,
        oneHourTsMs: htf1h.length ? htf1h[htf1h.length - 1]![TS] : null,
        fourHourTsMs: htf4h.length ? htf4h[htf4h.length - 1]![TS] : null,
      });
      // Per-wallet floor retired under cross margin; account-wide liquidation handled above.


      // ── STRATEGY MATRIX: symbols are never assigned to one strategy.
      //    Sweep and Break-and-Retest/DCA evaluate every canonical symbol.
      //    Regime remains evidence and may qualify a setup, but it no longer
      //    chooses the only detector allowed to inspect that symbol.
      //    Scout confirmed signals (Phase A.5) SUPERSEDE detector candidates
      //    for the same (sym, dir) when `DYNAMIC_UNIVERSE_ENABLED` is true;
      //    while the flag is false the Scout ingestion block is inert (see
      //    Phase A.5 header below).
      if (armedLeg === "hunter") hunter: {
        if (!setupDecision.allowed) {
          pushEval(sym, dir, "blocked_by_setup_timeframes", setupDecision.reason,
            trend.state, trend.slopePct, 0);
          break hunter;
        }



        // Hunter fill/reversal (variant='fill' from backtest_pnl_hunter.py):
        // scan the most recent volatility-gated FVGs (confirm within the
        // CATCHUP_CANDLES window) matching this direction. On the newest
        // candle, if price has now retraced into the gap, enter at the
        // worse-of-touched-edge — long: gap_upper, short: gap_lower — capped
        // at the candle open (mirrors backtest lines 137-144).
        const wantDir: Fvg["direction"] = dir === "long" ? "bullish" : "bearish";
        const advanceCursorH = async () => {
          const { data: updated } = await supabase.from("paper_wallets")
            .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
            .eq("id", wallet.id).select("*").single();
          if (updated) walletsByKey.set(wk, updated);
        };
        // Consider FVGs whose confirm is recent enough (retrace window not
        // yet expired at the newest candle).
        const eligible = hunterFvgs
          .filter((f) => f.direction === wantDir
            && f.confirmIndex < newestIdx
            && (newestIdx - f.confirmIndex) <= HUNTER_RETRACE_WINDOW)
          .sort((a, b) => b.confirmIndex - a.confirmIndex);
        if (eligible.length === 0) {
          pushEval(sym, dir, "hunter_no_fvg",
            `no volatility-gated ${wantDir} FVG in last ${HUNTER_RETRACE_WINDOW} candles (K=${HUNTER_K_THRESHOLD})`,
            trend.state, trend.slopePct, 0);
          await advanceCursorH(); break hunter;
        }
        const newestLo = newest[LOW], newestHi = newest[HIGH], newestOpen = newest[1];
        let picked: Fvg | null = null;
        let entryRawPx = 0;
        for (const f of eligible) {
          if (dir === "long" && newestLo <= f.gapUpper) {
            picked = f;
            entryRawPx = Math.min(f.gapUpper, newestOpen);
            break;
          }
          if (dir === "short" && newestHi >= f.gapLower) {
            picked = f;
            entryRawPx = Math.max(f.gapLower, newestOpen);
            break;
          }
        }
        if (!picked) {
          pushEval(sym, dir, "hunter_no_retest",
            `${eligible.length} eligible FVG(s) but no retrace on newest candle`,
            trend.state, trend.slopePct, 0);
          await advanceCursorH(); break hunter;
        }
        // STOP = far gap edge (long: gap_lower, short: gap_upper).
        const stopLvl = dir === "long" ? picked.gapLower : picked.gapUpper;
        if ((dir === "long" && !(stopLvl < entryRawPx)) ||
            (dir === "short" && !(stopLvl > entryRawPx))) {
          // Degenerate gap; skip.
          pushEval(sym, dir, "hunter_no_retest", "degenerate gap edge",
            trend.state, trend.slopePct, 0);
          await advanceCursorH(); break hunter;
        }
        // TP = next opposing swing beyond entry; fallback to mirror TP.
        const sw = nextOpposingHunterSwing(dir, picked.confirmIndex, entryRawPx);
        const tpLevelInit = sw?.level ?? mirrorTpFromStop(entryRawPx, stopLvl, dir);
        if (!sw) {
          pushEval(sym, dir, "hunter_no_swing_target",
            "no opposing hunter swing; using mirror TP",
            trend.state, trend.slopePct, 0);
        }

        const lev = leverageBySymbol.get(sym) ?? effectiveLeverage(null);
        const atrNow = atrAt[candles.length - 1];
        {
          const _guard = evaluateEntryAuthorization({
            regime: regimeBySymbol.get(sym) ?? "unknown",
            leverage: lev,
            symbol: sym,
          });
          if (!_guard.authorized) {
            pushEval(sym, dir, "blocked_wait_regime",
              _guard.blockDetail ?? "wait", trend.state, trend.slopePct, 0);
            await advanceCursorH(); break hunter;
          }
        }
        if (universeGate.active && !universeGate.allowedNewEntries.has(sym)) {
          pushEval(sym, dir, "blocked_universe_capacity",
            `universe gate (hunter): ${universeGate.reason}`, trend.state, trend.slopePct, 0);
          await advanceCursorH(); break hunter;
        }
        const L = sizeLadder(
          dir, entryRawPx, atrNow, lev, sym, "hunter", undefined, Number(wallet.balance),
        );
        const entryCandleTs = newest[TS];

        // PHASE A: queue candidate for Onyx. Advance cursor now so we don't
        // re-detect the same setup next tick regardless of Onyx's decision.
        const key = `${sym}:${dir}:hunter`;
        const hunterSigKey = `${sym}:${dir}:hunter:${picked.confirmTs}`;
        if (tradedKeys.has(hunterSigKey)) {
          pushEval(sym, dir, "already_traded",
            `hunter FVG already opened by this wallet (${picked.confirmTs})`,
            trend.state, trend.slopePct, 0);
          const { data: updated } = await supabase.from("paper_wallets")
            .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
            .eq("id", wallet.id).select("*").single();
          if (updated) walletsByKey.set(wk, updated);
          break hunter;
        }
        candidates.push({
          key, symbol: sym, base: sym.split("-")[0], direction: dir,
          leg: "hunter", regime, walletKey: wk,
          entryRawPx, fillPx: L.fillPx, stopLevel: L.stopLevel, tpLevel: L.tpLevel,
          zoneUpper: picked.gapUpper, zoneLower: picked.gapLower,
          zoneLevel: (picked.gapLower + picked.gapUpper) / 2,
          qty: L.totalQty, notional: L.totalNotional, margin: L.totalMargin,
          leverage: lev, entryFee: L.initialFee, entryCandleTs,
          openedFromSignal: hunterSigKey,
          trendState: trend.state, trendSlopePct: trend.slopePct,
          movementScore: rankScore(L.fillPx, L.stopLevel, L.tpLevel),
        });
        candidateExtras.set(key, { walletId: wallet.id, walletBalance: Number(wallet.balance), walletRow: wallet, rungs: L.rungs, marginPerRung: L.marginPerRung });

        {
          const { data: updated } = await supabase.from("paper_wallets")
            .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
            .eq("id", wallet.id).select("*").single();
          if (updated) walletsByKey.set(wk, updated);
        }
        break hunter;
      }


      if (CANONICAL_SCAN_SYMBOL_SET.has(sym)) sniper: {
        // NEUTRAL-REGIME LEG — liquidity-sweep strategy.
        // Canonical Zen contract: 15m closed-candle sweep detection and a
        // direction vote from 1h/4h/1d. Any two agreeing frames qualify.
        const advanceCursor = async () => {
          const { data: updated } = await supabase.from("paper_wallets")
            .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
            .eq("id", wallet.id).select("*").single();
          if (updated) walletsByKey.set(wk, updated);
        };
        const sweep = detectSweep({
          candles, atr: atrAt,
          htfBosState: "none", tick: feed.tick ?? 0,
        });
        if (!sweep || sweep.direction !== dir) {
          pushEval(sym, dir, "sniper_no_sweep",
            "no 15m liquidity sweep+retest / rejection on newest closed candle",
            trend.state, trend.slopePct, 0);
          await advanceCursor(); break sniper;
        }
        const alignmentStates = [htfBos.state, htf4hBos.state, htf1dBos.state] as const;
        if (!passesZenSweepAlignment(dir, alignmentStates)) {
          pushEval(sym, dir, "sniper_no_sweep",
            `alignment failed ${alignmentStates.join("/")}; queued for Council → Onyx`,
            trend.state, trend.slopePct, 0);
        }


        const entryRawPx = sweep.entry;
        const lev = leverageBySymbol.get(sym) ?? effectiveLeverage(null);
        const atrNow = atrAt[candles.length - 1];
        if (universeGate.active && !universeGate.allowedNewEntries.has(sym)) {
          pushEval(sym, dir, "blocked_universe_capacity",
            `universe gate (sweep): ${universeGate.reason}`, trend.state, trend.slopePct, 0);
          await advanceCursor(); break sniper;
        }
        const L = sizeLadder(
          dir, entryRawPx, atrNow, lev, sym, "sweep", sweep.stop, Number(wallet.balance),
        );
        const sweepStop = sweep.stop;
        const firstTarget = L.tpLevel;
        const entryCandleTs = newest[TS];

        const key = `${sym}:${dir}:sweep`;
        const sniperSigKey = `${sym}:${dir}:zen_sweep_v1:${entryCandleTs}:${sweep.mode}`;
        if (tradedKeys.has(sniperSigKey)) {
          pushEval(sym, dir, "already_traded",
            `sweep setup already opened by this wallet on candle ${entryCandleTs}`,
            trend.state, trend.slopePct, 0);
          await advanceCursor(); break sniper;
        }
        candidates.push({
          key, symbol: sym, base: sym.split("-")[0], direction: dir,
          leg: "sweep", regime, walletKey: wk,
          entryRawPx, fillPx: L.fillPx, stopLevel: sweepStop, tpLevel: firstTarget,
          zoneUpper: sweep.sweptLevel, zoneLower: sweep.sweptLevel, zoneLevel: sweep.sweptLevel,
          qty: L.totalQty, notional: L.totalNotional, margin: L.totalMargin,
          leverage: lev, entryFee: L.initialFee, entryCandleTs,
          openedFromSignal: sniperSigKey,
          trendState: trend.state, trendSlopePct: trend.slopePct,
          movementScore: rankScore(L.fillPx, sweepStop, firstTarget),
        });
        candidateExtras.set(key, { walletId: wallet.id, walletBalance: Number(wallet.balance), walletRow: wallet, rungs: L.rungs, marginPerRung: L.marginPerRung });

        await advanceCursor();
        break sniper;
      }


      if (CANONICAL_SCAN_SYMBOL_SET.has(sym)) {
      // Shared break-and-retest path — accumulator (aged trend) and vanguard
      // (fresh trend) reuse the SAME primitives from signal.ts. The two legs
      // diverge below at candidate construction: accumulator opens a full
      // maker ladder + DCA sibling; vanguard opens ONE full-size lot with
      // a structural stop just beyond the retested swing and no rungs.

      const evalRes = evalByDir[dir];
      if (!setupDecision.allowed) {
        pushEval(sym, dir, "blocked_by_setup_timeframes", setupDecision.reason,
          trend.state, trend.slopePct, 0);
        continue;
      }
      // We keep confirmedEntriesSince only for the fresh_count telemetry.
      const stepMs = INTERVAL_MIN * 60_000;
      const CATCHUP_CANDLES = 12;
      const rawCursor = wallet.last_processed_candle_ts_ms == null
        ? newestTs - CATCHUP_CANDLES * stepMs
        : Number(wallet.last_processed_candle_ts_ms);
      const cursor = Math.max(rawCursor, newestTs - CATCHUP_CANDLES * stepMs);
      const freshList = confirmedEntriesSince(evalRes, cursor);
      // NEW: propose the most-recent confirmed retest within the freshness
      // window that this wallet has not already traded. See eligibility.ts —
      // this replaces the old "only trade the brand-new candle" rule that
      // discarded ~99% of valid setups. Onyx (Phase B) still ranks/selects.
      const picked = pickFreshUntradedAccumulatorEntry(
        evalRes.entries, newestIdx,
        (i) => candles[i][TS],
        sym, dir, tradedKeys,
      );
      if (!picked) {
        // Distinguish "nothing confirmed in the window" from "all fresh
        // setups already traded" so telemetry stays actionable.
        const anyFreshExists = evalRes.entries.some(
          (r) => r.retest_index != null
            && (r.retest_index as number) >= newestIdx - ENTRY_FRESHNESS_CANDLES
            && (r.retest_index as number) <= newestIdx,
        );
        if (anyFreshExists) {
          pushEval(sym, dir, "already_traded",
            `fresh setup(s) exist but all already opened by this wallet`,
            trend.state, trend.slopePct, freshList.length);
        } else {
          pushEval(sym, dir, "no_confirmed_signal",
            `0 confirmed retests in last ${ENTRY_FRESHNESS_CANDLES + 1} candles`,
            trend.state, trend.slopePct, freshList.length);
        }
        const { data: updated } = await supabase.from("paper_wallets")
          .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
          .eq("id", wallet.id).select("*").single();
        if (updated) walletsByKey.set(wk, updated);
        continue;
      }
      const fresh = picked.retest;

      if (
        TREND_FILTER_ENABLED &&
        !trendAllowsDirection(trend.state, dir, TREND_NEUTRAL_BLOCKS)
      ) {
        if (dir === "long") blockedLong++; else blockedShort++;
        pushEval(sym, dir, "blocked_by_trend_filter",
          `trend=${trend.state ?? "null"} slope=${trend.slopePct?.toFixed(3) ?? "?"}%`,
          trend.state, trend.slopePct, freshList.length);
        const { data: updated } = await supabase.from("paper_wallets")
          .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
          .eq("id", wallet.id).select("*").single();
        if (updated) walletsByKey.set(wk, updated);
        continue;
      }

      const entryIdx = fresh.retest_index as number;
      const entryRawPx = candles[entryIdx][CLOSE];
      const stopSwing = stopPivot(swings, dir, entryIdx, entryRawPx);
      if (!stopSwing) {
        pushEval(sym, dir, "blocked_no_stop_pivot",
          "fresh signal but no opposing pivot for stop",
          trend.state, trend.slopePct, freshList.length);
        const { data: updated } = await supabase.from("paper_wallets")
          .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
          .eq("id", wallet.id).select("*").single();
        if (updated) walletsByKey.set(wk, updated);
        continue;
      }

      const lev = leverageBySymbol.get(sym) ?? effectiveLeverage(null);
      const atrNow = atrAt[candles.length - 1];
      {
        const _guard = evaluateEntryAuthorization({
          regime: regimeBySymbol.get(sym) ?? "unknown",
          leverage: lev,
          symbol: sym,
        });
        if (!_guard.authorized) {
          pushEval(sym, dir, "blocked_wait_regime",
            _guard.blockDetail ?? "wait", trend.state, trend.slopePct, 0);
          const { data: updated } = await supabase.from("paper_wallets")
            .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
            .eq("id", wallet.id).select("*").single();
          if (updated) walletsByKey.set(wk, updated);
          continue;
        }
      }
      if (universeGate.active && !universeGate.allowedNewEntries.has(sym)) {
        pushEval(sym, dir, "blocked_universe_capacity",
          `universe gate (accumulator): ${universeGate.reason}`, trend.state, trend.slopePct, 0);
        const { data: updated } = await supabase.from("paper_wallets")
          .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
          .eq("id", wallet.id).select("*").single();
        if (updated) walletsByKey.set(wk, updated);
        continue;
      }
      const L = sizeLadder(
        dir, entryRawPx, atrNow, lev, sym, armedLeg, undefined, Number(wallet.balance),
      );

      const entryCandleTs = candles[entryIdx][TS];

      {
        const entryLeg = armedLeg === "vanguard" ? "vanguard" : "accumulator";
        const key = `${sym}:${dir}:${entryLeg}`;
        candidates.push({
          key, symbol: sym, base: sym.split("-")[0], direction: dir,
          leg: entryLeg, regime, walletKey: wk,
          entryRawPx, fillPx: L.fillPx, stopLevel: L.stopLevel, tpLevel: L.tpLevel,
          zoneUpper: fresh.break_event.zone.upper, zoneLower: fresh.break_event.zone.lower,
          zoneLevel: fresh.break_event.zone.level,
          qty: L.totalQty, notional: L.totalNotional, margin: L.totalMargin,
          leverage: lev, entryFee: L.initialFee, entryCandleTs,
          openedFromSignal: picked.signalKey,
          trendState: trend.state, trendSlopePct: trend.slopePct,
          movementScore: rankScore(L.fillPx, L.stopLevel, L.tpLevel),
        });
        candidateExtras.set(key, { walletId: wallet.id, walletBalance: Number(wallet.balance), walletRow: wallet, rungs: L.rungs, marginPerRung: L.marginPerRung });

        // One detector event creates one campaign candidate. DCA is an
        // execution policy used only after Council→Onyx approval; it is not a
        // duplicate sibling candidate for the same break-and-retest alert.
      }


      const { data: updated } = await supabase.from("paper_wallets")
        .update({ last_processed_candle_ts_ms: newestTs, last_tick_at: new Date().toISOString() })
        .eq("id", wallet.id).select("*").single();
      if (updated) walletsByKey.set(wk, updated);
      } // end symbol-agnostic break-and-retest / DCA evaluation
    }


    perSymbol.push({
      symbol: sym,
      newestCandleTs: newestTs,
      opened,
      closed,
      trend: trend.state,
      trendEma: trend.ema,
      trendSlopePct: trend.slopePct,
      blockedLong,
      blockedShort,
      regime,
      armedLeg,
      htf_bos_state: htfBos.state,
      htf_bos_confirmed_at: htfBos.confirmedAtTs,
      htf_bos_bars_since: htfBos.barsSinceConfirm,
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE A.5 — SCOUT SIGNAL INGESTION
  // ════════════════════════════════════════════════════════════════════════
  // INERT while `DYNAMIC_UNIVERSE_ENABLED` is false: the block below still
  // runs to keep the query surface and telemetry warm for re-enable, but
  // every synthesized candidate is rejected below with
  // `blocked_universe_capacity` because `universeGate.active === false`
  // rejects every symbol. Zero Scout-originated candidates reach
  // `decideOnyxForCandidates` while the flag is off — the legacy
  // Hunter / Sniper / Accumulator open path is authoritative.
  //
  // When the flag flips true (and `computeUniverseGate` is wired back in),
  // fresh confirmed Scout signals (long_state|short_state = 'confirmed'
  // AND _fresh = true, non-invalidated, not expired) synthesize an
  // OnyxCandidate per (symbol, side) so Onyx gets called under the
  // dynamic-universe model where pod-bound wallets have no pre-armed leg
  // for the scanned symbol. Wallet-local detectors keep priority for the
  // same (symbol, direction) unless a Scout signal supersedes them.
  //
  // Sole-authority contract preserved: gated by universeGate.allowedNewEntries.
  // Prices are only ever taken from the tick's newest completed candle — no
  // synthetic marks.
  // Collect the scout_signal ids ingested this tick so we can (1) skip already-
  // decided signals, (2) persist HOLD/REJECT onyx_decisions after Phase B.

  const scoutSignalByCandidateKey = new Map<string, { signalId: string; scanId: string; createdAtMs: number }>();
  try {
    const nowIso = new Date().toISOString();
    const scoutRes = await supabase
      .from("scout_signals")
      .select("id,symbol,scan_id,long_state,long_fresh,short_state,short_fresh,market_regime,created_at,expires_at,invalidated_at,regime_schema_version")
      .eq("user_id", userId)
      .gt("expires_at", nowIso)
      .or("and(long_state.eq.confirmed,long_fresh.eq.true),and(short_state.eq.confirmed,short_fresh.eq.true)")
      .order("created_at", { ascending: false })
      .limit(200);
    const scoutRows = (scoutRes.data ?? []) as unknown as RawScoutSignalRow[];

    // "Delivered once" dedupe: any scout_signal that already produced an
    // onyx_decisions row for THIS user is skipped, regardless of freshness.
    let alreadyDecided: Set<string> | undefined;
    if (scoutRows.length > 0) {
      const ids = scoutRows.map((r) => r.id);
      const { data: dec } = await supabase
        .from("onyx_decisions")
        .select("detail")
        .eq("user_id", userId)
        .gte("decision_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(2000);
      alreadyDecided = new Set<string>();
      for (const d of dec ?? []) {
        const sid = (d.detail as { scout_signal_id?: string } | null)?.scout_signal_id;
        if (typeof sid === "string" && ids.includes(sid)) alreadyDecided.add(sid);
      }
    }

    const scoutSides = selectFreshScoutSides(scoutRows, {
      nowMs: Date.now(),
      evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
      alreadyDecidedSignalIds: alreadyDecided,
    });

    // Fast lookup for feeds already fetched by the outer symbol loop.
    const feedBySymbol = new Map<string, typeof feeds[number]["feed"]>();
    for (const f of feeds) if (f.feed) feedBySymbol.set(f.sym, f.feed);

    // OWNER POLICY: Scout confirmed signals SUPERSEDE wallet-local detector
    // candidates for the same (symbol, direction). When a Scout signal exists
    // we drop any previously-queued detector candidate for that pair before
    // proposing the Scout candidate below.
    for (const s of scoutSides) {
      const sym = s.symbol;
      const dir = s.direction;
      // Sole-authority: only ingest for symbols the universe gate allows.
      if (!universeGate.active || !universeGate.allowedNewEntries.has(sym)) {
        pushEval(sym as PaperSymbol, dir, "blocked_universe_capacity",
          `scout signal ${s.signalId.slice(0, 8)}: ${universeGate.reason ?? "not_allowed"}`,
          null, null, 0);
        continue;
      }
      // Supersede: purge any detector candidates for this (sym, dir).
      const prefix = `${sym}:${dir}:`;
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i].key.startsWith(prefix)) {
          candidateExtras.delete(candidates[i].key);
          candidates.splice(i, 1);
        }
      }



      const feed = feedBySymbol.get(sym);
      if (!feed || !feed.candles.length) {
        pushEval(sym as PaperSymbol, dir, "scout_no_candle",
          `scout signal ${s.signalId.slice(0, 8)}: no completed candle in feed`,
          null, null, 0);
        continue;
      }
      const scoutCandles = feed.candles;
      const scoutNewest = scoutCandles[scoutCandles.length - 1];
      const entryRawPx = scoutNewest[4]; // CLOSE
      const entryCandleTs = scoutNewest[0]; // TS

      const scoutSigKey = `${sym}:${dir}:scout:${s.signalId}`;
      if (tradedKeys.has(scoutSigKey)) {
        pushEval(sym as PaperSymbol, dir, "already_traded",
          `scout signal ${s.signalId.slice(0, 8)} already opened by this wallet`,
          null, null, 0);
        continue;
      }

      // Regime gate — use the scout row's regime when present, otherwise the
      // cached regimeBySymbol (from the earlier scout_signals query).
      const regimeForGuard = (s.regime as import("../scout/regime").MarketRegime | null) ?? regimeBySymbol.get(sym) ?? "unknown";
      const lev = leverageBySymbol.get(sym) ?? effectiveLeverage(null);
      const guard = evaluateEntryAuthorization({ regime: regimeForGuard, leverage: lev, symbol: sym });
      if (!guard.authorized) {
        pushEval(sym as PaperSymbol, dir, "blocked_wait_regime",
          `scout: ${guard.blockDetail ?? "wait"}`, null, null, 0);
        continue;
      }

      // Scout uses the directional role wallet. Resolve it before sizing so
      // the five-rung campaign is based on that wallet's settled balance.
      const picked = walletsByKey.get(dir) ?? null;
      if (!picked) {
        pushEval(sym as PaperSymbol, dir, "onyx_capacity",
          "scout: destination role wallet is unavailable",
          null, null, 0);
        continue;
      }

      // Size the ladder from the newest close + tick ATR.
      let sized: ReturnType<typeof sizeLadder>;
      try {
        const scoutAtr = wilderAtrSeries(scoutCandles);
        const atrNow = scoutAtr[scoutCandles.length - 1];
        sized = sizeLadder(
          dir, entryRawPx, atrNow, lev, sym, "scout", undefined, Number(picked.balance),
        );
      } catch (err) {
        pushEval(sym as PaperSymbol, dir, "blocked_wait_regime",
          `scout size error: ${(err as Error)?.message ?? "unknown"}`, null, null, 0);
        continue;
      }

      // Regime tag for the OnyxCandidate row is the paper Regime enum, not
      // the Scout MarketRegime — use the symbolCtx snapshot when available.
      const paperRegime = symbolCtx.get(sym)?.regime ?? null;
      const trendState = symbolCtx.get(sym)?.trendState ?? null;
      const trendSlopePct = symbolCtx.get(sym)?.trendSlopePct ?? null;

      const key = `${sym}:${dir}:scout`;
      candidates.push({
        key, symbol: sym, base: sym.split("-")[0], direction: dir,
        leg: "scout", regime: paperRegime, walletKey: picked.wallet_key,
        entryRawPx, fillPx: sized.fillPx, stopLevel: sized.stopLevel, tpLevel: sized.tpLevel,
        zoneUpper: entryRawPx, zoneLower: entryRawPx, zoneLevel: entryRawPx,
        qty: sized.totalQty, notional: sized.totalNotional, margin: sized.totalMargin,
        leverage: lev, entryFee: sized.initialFee, entryCandleTs,
        openedFromSignal: scoutSigKey,
        trendState, trendSlopePct,
        movementScore: rankScore(sized.fillPx, sized.stopLevel, sized.tpLevel),
      });
      candidateExtras.set(key, {
        walletId: picked.id, walletBalance: Number(picked.balance), walletRow: picked,
        rungs: sized.rungs, marginPerRung: sized.marginPerRung,
      });
      scoutSignalByCandidateKey.set(key, {
        signalId: s.signalId, scanId: s.scanId, createdAtMs: s.createdAtMs,
      });
      // (superseded detector candidates already purged above)
      pushEval(sym as PaperSymbol, dir, "scout_ingested",
        `scout ${s.signalId.slice(0, 8)} → candidate on wallet ${picked.wallet_key}`,
        trendState, trendSlopePct, 0);
    }
  } catch (err) {
    // Ingestion is best-effort. A query failure must NOT kill the tick —
    // wallet-local detectors + open-book management still run.
    pushEval("-" as PaperSymbol, "long", "onyx_no_call",
      `scout ingestion failed: ${(err as Error)?.message ?? "unknown"}`, null, null, 0);
  }

  // ── FOUR-WALLET ENTRY ROUTER ─────────────────────────────────────────
  // Strategy detection is symbol-agnostic. The completed 1h/4h/1d vote
  // decides only where a valid opportunity goes:
  //   2/3 aligned -> Long or Short wallet (no AI)
  //   failed vote -> Council -> Onyx -> Strategy-wallet DCA
  // Council and Onyx are stages, not wallets.
  const routedCandidates: OnyxCandidate[] = [];
  const openCampaignsAtRouting = Array.from(openBySlot.values()).map((p) => ({
    symbol: p.symbol,
    walletKey: p.wallet_key,
    direction: p.direction as Direction,
  }));
  for (const original of candidates) {
    const authorization = authorizePaperCandidate(paperRuntime.controlled,
      paperRuntime.routes ?? [], original.symbol, original.leg);
    if (!authorization.allowed) {
      pushEval(original.symbol, original.direction, "onyx_skipped", authorization.reason,
        original.trendState, original.trendSlopePct, 0);
      continue;
    }
    const ctx = symbolCtx.get(original.symbol);
    if (!ctx) continue;
    const route = routeFourWalletOpportunity({
      symbol: original.symbol,
      direction: original.direction,
      alignmentStates: [ctx.htfBosState, ctx.htf4hBosState, ctx.htf1dBosState],
      openCampaigns: openCampaignsAtRouting,
      hedgeRequired: regimeBySymbol.get(original.symbol) === "opposing_to_open_position",
    });
    if (!route.accepted) {
      pushEval(original.symbol, original.direction, "position_open",
        `four-wallet router blocked: ${route.reason}`,
        original.trendState, original.trendSlopePct, 0);
      continue;
    }

    const oldExtras = candidateExtras.get(original.key);
    const routedKey = route.selectionPath === "council_then_onyx"
      ? `${original.key}:council`
      : original.key;
    const routed: OnyxCandidate = {
      ...original,
      key: routedKey,
      walletKey: route.walletKey,
      leg: route.executionStrategy === "dca" ? "dca" : original.leg,
    };

    if (oldExtras) {
      const walletRow = walletsByKey.get(route.walletKey);
      if (!walletRow) {
        pushEval(original.symbol, original.direction, "wallet_missing",
          `four-wallet role missing: ${route.walletKey}`,
          original.trendState, original.trendSlopePct, 0);
        continue;
      }
      const availableEquity = Number(walletRow.balance);
      if (!(availableEquity > 0)) {
        pushEval(original.symbol, original.direction, "onyx_capacity",
          `destination wallet ${route.walletKey} has no settled balance`,
          original.trendState, original.trendSlopePct, 0);
        continue;
      }
      const desiredMargin = sizeWalletCampaign({
        settledWalletBalance: availableEquity,
        leverage: routed.leverage,
      }).committedMargin;
      const oldMargin = oldExtras.rungs.reduce((sum, rung) => sum + rung.margin, 0);
      if (!(oldMargin > 0) || !(desiredMargin > 0)) {
        pushEval(original.symbol, original.direction, "open_failed",
          "wallet campaign sizing produced no executable margin",
          original.trendState, original.trendSlopePct, 0);
        continue;
      }
      const scale = desiredMargin / oldMargin;
      const rungs = oldExtras.rungs.map((rung) => ({
        ...rung,
        margin: rung.margin * scale,
        qty: rung.qty * scale,
      }));
      routed.margin = rungs.reduce((sum, rung) => sum + rung.margin, 0);
      routed.qty = rungs.reduce((sum, rung) => sum + rung.qty, 0);
      routed.notional = rungs.reduce((sum, rung) => sum + rung.qty * rung.price, 0);
      candidateExtras.delete(original.key);
      candidateExtras.set(routedKey, {
        walletId: walletRow.id,
        walletBalance: availableEquity,
        walletRow,
        rungs,
        marginPerRung: rungs[0]?.margin ?? oldExtras.marginPerRung,
      });
    }
    candidateSelectionPath.set(routedKey, route.selectionPath);
    candidateDetector.set(routedKey, original.leg);
    if (authorization.route) candidatePlan.set(routedKey, authorization.route);
    if (authorization.executingTurtle) candidateExecutingTurtle.set(routedKey, authorization.executingTurtle);
    routedCandidates.push(routed);
  }
  candidates.splice(0, candidates.length, ...routedCandidates);


  // ════════════════════════════════════════════════════════════════════════
  // PHASE B — ONYX DECIDES
  // ════════════════════════════════════════════════════════════════════════
  // Feed Onyx the collected candidates + fleet state. Onyx applies hard
  // guardrails first, then (if we still have candidates and free capacity)
  // asks GPT-5.5 to rank/pick. Cost control: skip the AI call when there is
  // nothing to decide. Fail-safe: on any AI error, fall back to a
  // deterministic guardrail-approved deploy so the bot keeps trading.
  const openPositionsNow = Array.from(openBySlot.values());
  const openCount = openPositionsNow.length;
  const altOpenCount = openPositionsNow.filter((p) => !ANCHOR_BASES.has(p.symbol.split("-")[0])).length;
  const freeWalletCount = Math.max(0, ONYX_MAX_TOTAL_OPEN - openCount);

  // Build OPEN-POSITION snapshot for Onyx open-book review from the
  // positions that SURVIVED manage-phase exits this tick.
  const openPositionSnapshots: OnyxOpenPosition[] = [];
  for (const pos of openBySlot.values()) {
    const wk = pos.wallet_key;
    const ctx = symbolCtx.get(pos.symbol);
    if (!ctx) continue;
    const dirP: Direction = pos.direction as Direction;
    const dirSign = dirP === "long" ? 1 : -1;
    const worstPx = dirP === "long" ? ctx.newestLow : ctx.newestHigh;
    const markPx = ctx.newestClose;
    const entryPx = Number(pos.entry_price);
    const qty = Number(pos.size_qty);
    const marginAmt = Number(pos.margin) || 1;
    // Net-of-fees ROI. Modeled exit fee = markPx × qty × FEE_RATE (taker exit
    // via applySlip omitted for the mark — bounded by the FEE_RATE haircut).
    const grossUnrealized = (markPx - entryPx) * qty * dirSign;
    const entryFeeAmt = Number(pos.entry_fee) || 0;
    const exitFeeAmt = markPx * qty * FEE_RATE;
    const netUnrealized = grossUnrealized - entryFeeAmt - exitFeeAmt;
    const pnlPctOfMargin = (netUnrealized / marginAmt) * 100;
    const ageMs = Date.now() - new Date(pos.entry_ts).getTime();
    // ── DCA rung state — passed to Onyx as CONTEXT only. `validateAiClose`
    //    is what actually rejects a mid-ladder AI cut, regardless of what
    //    the AI sees here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawFills = Array.isArray((pos as any).fills) ? ((pos as any).fills as Array<{ price?: number; margin?: number }>) : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawPending = Array.isArray((pos as any).pending_rungs) ? ((pos as any).pending_rungs as Array<{ price?: number; margin?: number }>) : [];
    const filledRungCount = pos.rung_count ?? rawFills.length ?? 1;
    const pendingRungCount = rawPending.length;
    const totalPlannedRungs = (pos.ladder_total_rungs as number | null | undefined)
      ?? (filledRungCount + pendingRungCount);
    const levForCtx = Number(pos.leverage) || TARGET_LEVERAGE;
    const persistedTotalMargin = Number(pos.ladder_total_margin ?? pos.margin);
    const perRungMargin = totalPlannedRungs > 0 && persistedTotalMargin > 0
      ? persistedTotalMargin / totalPlannedRungs
      : dcaMarginPerRungForLeverage(levForCtx);
    const totalPlannedMargin = persistedTotalMargin > 0
      ? persistedTotalMargin
      : perRungMargin * totalPlannedRungs;
    const deepestRungPrice = rawPending.concat(rawFills)
      .map((r) => Number(r?.price ?? NaN))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reduce<number>((best, p) => {
        if (!Number.isFinite(best) || best === 0) return p;
        return dirP === "long" ? Math.min(best, p) : Math.max(best, p);
      }, 0) || Number(pos.stop_level);
    const nextRungPrice = rawPending
      .map((r) => Number(r?.price ?? NaN))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reduce<number | null>((best, p) => {
        if (best == null) return p;
        return dirP === "long" ? Math.max(best, p) : Math.min(best, p);
      }, null);
    openPositionSnapshots.push({
      walletKey: wk,
      positionId: pos.id,
      symbol: pos.symbol,
      base: pos.symbol.split("-")[0],
      direction: dirP,
      strategy: (pos.strategy ?? "accumulator") as "accumulator" | "sniper" | "hunter" | "dca" | "scout",
      entryPx, worstPx, markPx, qty, margin: marginAmt,
      pnlPctOfMargin,
      ageMinutes: ageMs / 60_000,
      regime: ctx.regime,
      trendState: ctx.trendState,
      trendSlopePct: ctx.trendSlopePct,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      structureBroken: Boolean((pos as any).structure_broken),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      brokenLevel: (pos as any).structure_broken_level ?? (pos as any).protective_swing_level ?? null,
      filledRungCount, pendingRungCount, totalPlannedRungs,
      perRungMargin, totalPlannedMargin,
      deepestRungPrice,
      // Strategy hard stop is unarmed until every rung has filled — expose
      // null so Onyx cannot mistake a placeholder for permission to close.
      hardStopLevel: pendingRungCount === 0 ? Number(pos.stop_level) : null,
      nextRungPrice,
    });
  }


  // Pull recent trades for bench state whenever we have candidates OR open
  // positions to review (bench state gates candidate deploys only).
  let benchedWallets: string[] = [];
  if (candidates.length > 0 || openPositionSnapshots.length > 0) {
    const { data: tRows } = await supabase
      .from("paper_trades")
      .select("wallet_key,exit_reason,closed_at")
      .eq("user_id", userId)
      .order("closed_at", { ascending: false })
      .limit(ONYX_RECENT_TRADE_LIMIT);
    benchedWallets = computeBenchedWallets(
      (tRows ?? []).map((t) => ({
        walletKey: t.wallet_key,
        exitReason: String(t.exit_reason ?? ""),
        closedAt: String(t.closed_at ?? ""),
      })),
      ONYX_BENCH_STOPS,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE B.2 — HEDGE REVIEW (advisory-only in paper).
  // ════════════════════════════════════════════════════════════════════════
  // Only fires when Scout classifies an open core position's regime as
  // `opposing_to_open_position` AND every pre-flight guard passes: fresh
  // opposing signal, sufficient margin for the opposing formation,
  // cooldown clear, venue capability preflighted. Negative PnL alone is
  // NEVER a trigger — the trigger is the regime classification. Result
  // is persisted via pushEval → bot_events; the paper engine takes NO
  // paper Hedge-wallet execution action until all pre-flight checks pass.
  const _nowMsHedge = Date.now();
  const hedgeOutcomes: HedgeReviewOutcome[] = [];
  for (const openSnap of openPositionSnapshots) {
    // openSnap.regime is the paper Regime enum ("trend"|"neutral"|"high_vol").
    // The Scout MarketRegime (7-state) is what the hedge planner needs.
    const marketRegime = regimeBySymbol.get(openSnap.symbol) ?? "unknown";
    if (marketRegime !== "opposing_to_open_position") continue;
    const opposing = candidates.find(
      (c) => c.symbol === openSnap.symbol && c.direction !== openSnap.direction,
    );
    const proposedDirection = opposing?.direction ?? null;
    const freshSignal = !!opposing;
    const marginNeeded = opposing?.margin ?? 0;
    // Available margin is the wallet balance of the wallet that would take
    // the opposing entry (from candidateExtras). If no opposing candidate,
    // marginNeeded is 0 and freshSignal is false — the review short-circuits.
    const walletExtra = opposing ? candidateExtras.get(opposing.key) : undefined;
    const availableMargin = walletExtra?.walletBalance ?? 0;
    const hasSufficientMargin = marginNeeded > 0 && availableMargin >= marginNeeded;
    // This is the paper venue: Long/Short/Hedge are separate role wallets, so
    // an opposite Hedge position cannot net the core position away.
    const review = reviewHedgeForOpenPosition({
      positionId: openSnap.positionId,
      symbol: openSnap.symbol,
      openDirection: openSnap.direction,
      regime: marketRegime,
      hedgeSupported: PAPER_VENUE.supportsSimultaneousLongShort,
      proposedDirection,
      freshSignal,
      hasSufficientMargin,
      lastProposalAtMs: null,
      nowMs: _nowMsHedge,
    });
    hedgeOutcomes.push(review);
    if (review.status === "proposed") {
      pushEval(openSnap.symbol as PaperSymbol, openSnap.direction, "hedge_proposed",
        `action=${review.plan.action} execute=${review.execute}`,
        null, null, 0);
    } else if (review.status === "rejected") {
      pushEval(openSnap.symbol as PaperSymbol, openSnap.direction, "hedge_rejected",
        review.reason, null, null, 0);
    }
    // status === "not_applicable" is intentionally not logged to keep
    // bot_events noise-free — the vast majority of open positions are not
    // in the opposing regime.
  }

  // Symbols where the OPEN book is in `opposing_to_open_position` regime AND
  // the hedge planner already approved a native-hedge proposal. Any Onyx-
  // approved candidate for these symbols that opposes the current open leg
  // routes through the pod's opposite leg (purpose="hedge") instead of
  // fighting for a fresh primary pod.
  const hedgeableSymbols = new Set<string>();
  for (const h of hedgeOutcomes) {
    if (h.status === "proposed" && h.execute && h.plan.action === "native_hedge") {
      const snap = openPositionSnapshots.find((s) => s.positionId === h.positionId);
      if (snap) hedgeableSymbols.add(snap.symbol);
    }
  }


  const fleetSnapshot: FleetSnapshot = {
    walletCount: walletsByKey.size,
    openCount, altOpenCount, freeWalletCount, benchedWallets,
    maxTotalOpen: ONYX_MAX_TOTAL_OPEN,
    maxAltPositions: ONYX_MAX_ALT_POSITIONS,
    benchConsecutiveStops: ONYX_BENCH_STOPS,
  };

  const decisionStartMs = Date.now();
  const coreCandidates = candidates
    .filter((candidate) => {
      const path = candidateSelectionPath.get(candidate.key);
      return path === "core_2_of_3" || path === "hedge_protection";
    })
    .sort((a, b) => b.movementScore - a.movementScore);
  const councilCandidates = candidates
    .filter((candidate) => candidateSelectionPath.get(candidate.key) === "council_then_onyx")
    .sort((a, b) => b.movementScore - a.movementScore);

  const claimedSymbols = new Set(openPositionSnapshots.map((position) => position.symbol));
  const coreApproved: Decision["approved"] = [];
  const routedRejected: Decision["rejected"] = [];
  for (const candidate of coreCandidates) {
    const isHedgeProtection = candidateSelectionPath.get(candidate.key) === "hedge_protection";
    // An occupied symbol blocks a new core/Strategy campaign, but it is the
    // prerequisite for the one permitted opposite Hedge campaign.
    if ((!isHedgeProtection && claimedSymbols.has(candidate.symbol))
      || (!isHedgeProtection && claimedSymbols.size >= ONYX_MAX_TOTAL_OPEN)) {
      routedRejected.push({ candidate, reason: "onyx_capacity" });
      continue;
    }
    if (!isHedgeProtection) claimedSymbols.add(candidate.symbol);
    coreApproved.push({
      ...candidate,
      rationale: candidateSelectionPath.get(candidate.key) === "hedge_protection"
        ? "confirmed opposing regime → Hedge wallet protection"
        : `automatic 2-of-3 alignment → ${candidate.walletKey} wallet`,
      priority: coreApproved.length + 1,
    });
  }

  // Onyx is a final selector for Council-routed rejects only. Core and Hedge
  // positions remain under deterministic management, so the legacy open-book
  // model receives neither deploy candidates nor positions to close.
  const glm = resolveGlmTransport(process.env);
  const openBookDecision = await decideOnyxForCandidates(
    [], fleetSnapshot, glm.apiKey ?? null, fetch, [], glm,
  );

  const { orchestratePaperCandidate } = await import("./aiOrchestration.server");
  type OrchestrationOutcome = Awaited<ReturnType<typeof orchestratePaperCandidate>>;
  const orchestrationByKey = new Map<string, OrchestrationOutcome>();
  const aiApproved: Decision["approved"] = [];
  const { fetchEnvironmentContext } = await import("./environmentFrames");
  const councilEnvironment = new Map<string, Awaited<ReturnType<typeof fetchEnvironmentContext>>>();
  for (const candidate of councilCandidates) {
    // Check before Council. Onyx and the final risk check repeat this lock.
    if (!aiSelectionSymbolAvailable(candidate.symbol, openCampaignsAtRouting)
      || claimedSymbols.has(candidate.symbol)) {
      routedRejected.push({ candidate, reason: "onyx_capacity" });
      continue;
    }
    const ctx = symbolCtx.get(candidate.symbol);
    if (!councilEnvironment.has(candidate.symbol)) {
      try {
        councilEnvironment.set(candidate.symbol, await fetchEnvironmentContext(candidate.symbol));
      } catch {
        // Daily/weekly/monthly context is advisory. Snapshot/risk checks stay
        // fail-closed on the required 15m/1h/4h/1d evidence below.
      }
    }
    const result = await orchestratePaperCandidate(supabase, userId, {
      key: candidate.key,
      symbol: candidate.symbol,
      direction: candidate.direction,
      leg: "dca",
      entryCandleTs: candidate.entryCandleTs,
      fillPx: candidate.fillPx,
      stopLevel: candidate.stopLevel,
      tpLevel: candidate.tpLevel,
      zoneLower: candidate.zoneLower,
      zoneUpper: candidate.zoneUpper,
      margin: candidate.margin,
      notional: candidate.notional,
      leverage: candidate.leverage,
      regime: candidate.regime,
      trendState: candidate.trendState,
      trendSlopePct: candidate.trendSlopePct,
      movementScore: candidate.movementScore,
      marketEvidence: ctx?.marketEvidence ?? null,
      htf: ctx ? {
        bos1h: ctx.htfBosState,
        bos4h: ctx.htf4hBosState,
        bos1d: ctx.htf1dBosState,
        lastClosed4hMs: ctx.htf4hLastClosedTs,
        lastClosed1hMs: ctx.htf1hLastClosedTs,
        lastClosed1dMs: ctx.htf1dLastClosedTs,
        lastClosed15mMs: ctx.htf15mLastClosedTs,
      } : null,
      env: councilEnvironment.get(candidate.symbol) ?? null,
      deterministicApproved: true,
      selectionPath: "council_then_onyx",
    });
    orchestrationByKey.set(candidate.key, result);
    if (result.allowed) {
      claimedSymbols.add(candidate.symbol);
      aiApproved.push({
        ...candidate,
        leg: "dca",
        walletKey: "strategy",
        rationale: `Council selected; Onyx approved: ${result.onyxRationale}`,
        priority: coreApproved.length + aiApproved.length + 1,
      });
    } else {
      routedRejected.push({ candidate, reason: "onyx_held" });
    }
  }

  const decision: Decision = {
    ...openBookDecision,
    approved: [...coreApproved, ...aiApproved].map((candidate, index) => ({
      ...candidate,
      priority: index + 1,
    })),
    rejected: [...routedRejected, ...openBookDecision.rejected],
    aiCalled: aiApproved.length > 0 || councilCandidates.length > 0,
    skipReason: candidates.length === 0 ? "no_candidates" : null,
  };
  const decisionLatencyMs = Date.now() - decisionStartMs;
  type OnyxDecisionInsert = Database["public"]["Tables"]["onyx_decisions"]["Insert"];
  const persistOnyxDecision = async (
    candidate: OnyxCandidate,
    decisionValue: "approved" | "rejected" | "hold",
    rejectReason: string | null,
    detail: Record<string, unknown>,
  ): Promise<string | null> => {
    const scoutMeta = scoutSignalByCandidateKey.get(candidate.key);
    const row: OnyxDecisionInsert = {
      user_id: userId,
      correlation_id: crypto.randomUUID(),
      symbol: candidate.symbol,
      side: candidate.direction,
      decision: decisionValue,
      reject_reason: rejectReason,
      strategy: candidate.leg,
      wallet_id: candidateExtras.get(candidate.key)?.walletId ?? null,
      confidence: Math.max(0.01, Math.min(0.99, candidate.movementScore / 100)),
      scan_id: scoutMeta?.scanId ?? null,
      envelope_version: EVIDENCE_SCHEMA_VERSION,
      rules_version: RULES_VERSION,
      supporting_codes: decisionValue === "approved" ? ["phase_b_approved"] : [],
      conflicting_codes: rejectReason ? [rejectReason] : [],
      risk_check: {
        margin: candidate.margin,
        notional: candidate.notional,
        leverage: candidate.leverage,
        movement_score: candidate.movementScore,
      } as unknown as OnyxDecisionInsert["risk_check"],
      signal_at: new Date(scoutMeta?.createdAtMs ?? candidate.entryCandleTs).toISOString(),
      decision_at: new Date().toISOString(),
      decision_latency_ms: decisionLatencyMs,
      detail: detail as unknown as OnyxDecisionInsert["detail"],
    };
    const { data, error } = await supabase.from("onyx_decisions").insert(row).select("id").maybeSingle();
    return error ? null : ((data?.id as string | undefined) ?? null);
  };

  if (decision.skipReason === "no_candidates" && candidates.length === 0 && openPositionSnapshots.length === 0) {
    // nothing to record beyond the standard buckets
  } else if (decision.skipReason === "no_candidates") {
    pushEval(candidates[0]?.symbol ?? "-", "long", "onyx_no_call",
      "no survivor candidates after guardrails", null, null, 0);
  } else if (decision.skipReason === "no_capacity") {
    pushEval("-" as PaperSymbol, "long", "onyx_no_call",
      `no free-wallet capacity (${freeWalletCount})`, null, null, 0);
  } else if (decision.usedFallback) {
    pushEval("-" as PaperSymbol, "long", "onyx_fallback",
      decision.aiError ?? "deterministic fallback", null, null, 0);
  }


  // ════════════════════════════════════════════════════════════════════════
  // PHASE C — EXECUTE Scout-confirmed BOS closes first, then
  // approved deploys. Mechanical exits (per-lot TP touches, hard stop past
  // deepest rung, account-wide cross liquidation) already ran in the manage
  // phase. Onyx/AI has no discretionary close authority.
  // ════════════════════════════════════════════════════════════════════════
  const closedBySymbol = new Map<string, number>();

  for (const oc of decision.closes) {
    const wk = oc.position.walletKey;
    const closeSlotKey = campaignSlotKey(wk, oc.position.symbol);
    const pos = openBySlot.get(closeSlotKey);
    if (!pos) continue;                   // manage phase already exited it
    const px = newestPxBySymbol.get(pos.symbol);
    if (px == null) continue;
    const dirP = pos.direction as Direction;
    const dirSign = dirP === "long" ? 1 : -1;
    const qty = Number(pos.size_qty);
    const entry = Number(pos.entry_price);
    const exitPx = applySlip(px, dirP, false);   // taker exit
    const exitFee = exitPx * qty * FEE_RATE;
    const entryFee = Number(pos.entry_fee);
    const grossPnl = (exitPx - entry) * qty * dirSign;
    const netPnl = grossPnl - exitFee - entryFee;

    // Atomic close via SECURITY DEFINER RPC (Phase 4B). Combines the CAS
    // status='open'→'closed', trade insert, wallet stats bump, and
    // paper_accounts balance/realized-PnL update into a single transaction.
    // Idempotency: (user_id, op_key) keyed on the position id + Onyx close
    // reason so a raced or replayed tick cannot double-realize PnL.
    const openedAtMs = new Date(pos.entry_ts).getTime();
    // `oc.reason` is one of the deterministic-validator-approved reasons only:
    // "scout_bos" (Scout force-close) or "bank_profit" (AI close approved by
    // `validateAiClose`, requires pnl_roi ≥ ONYX_BANK_PROFIT_MARGIN_ROI_PCT).
    const exitReason = oc.reason;
    const closedAtIso = new Date().toISOString();
    const trade = {
      wallet_key: wk, symbol: pos.symbol, direction: dirP,
      entry_price: entry, exit_price: exitPx, exit_reason: exitReason,
      size_qty: qty, size_notional: Number(pos.size_notional),
      margin: Number(pos.margin), leverage: Number(pos.leverage),
      pnl_gross: grossPnl, fees: entryFee + exitFee,
      slippage_cost: Math.abs(exitPx - px) * qty, pnl_net: netPnl,
      hold_seconds: Math.max(1, Math.round((Date.now() - openedAtMs) / 1000)),
      opened_at: pos.entry_ts, closed_at: closedAtIso,
    };
    const wRow = walletsByKey.get(wk);
    const isWin = netPnl > 0;
    const opKey = `close:${pos.id}:${exitReason}`;
    const fp = await fingerprintPayload({ trade, delta: netPnl });
    const closeRes = await repoClosePosition(supabase, {
      userId, positionId: pos.id, lastSeenCandleTsMs: null,
      trades: [trade], accountDelta: netPnl,
      walletId: wRow?.id ?? null,
      walletStats: wRow ? { trades_delta: 1, wins_delta: isWin ? 1 : 0, losses_delta: isWin ? 0 : 1 } : null,
      opKey, fingerprint: fp,
    });
    if (!closeRes.result.ok) { openBySlot.delete(closeSlotKey); continue; }
    const already = (closeRes.result.value as { already_closed?: boolean })?.already_closed === true;
    if (already) { openBySlot.delete(closeSlotKey); continue; }
    if (wRow) {
      // Reflect updated stats locally so downstream markPortfolio() is exact.
      walletsByKey.set(wk, {
        ...wRow,
        open_position_id: null,
        balance: Number(wRow.balance) + netPnl,
        realized_pnl: Number(wRow.realized_pnl ?? 0) + netPnl,
        trades_count: (wRow.trades_count ?? 0) + 1,
        wins_count: (wRow.wins_count ?? 0) + (isWin ? 1 : 0),
        losses_count: (wRow.losses_count ?? 0) + (isWin ? 0 : 1),
      } as typeof wRow);
    }
    accountBalance += netPnl;
    realizedDelta += netPnl;
    openBySlot.delete(closeSlotKey);
    closedBySymbol.set(pos.symbol, (closedBySymbol.get(pos.symbol) ?? 0) + 1);
    // Both surfaced reasons currently bucket under the existing `scout_bos`
    // telemetry outcome — the exact reason lives on the trade row itself.
    pushEval(pos.symbol as PaperSymbol, dirP, "scout_bos" as EvalReason,
      `${exitReason}: ${oc.rationale}`, null, null, 0);
  }

  // ── Rejected AI closes: log EACH one (sanitized) so we can prove after
  //    the fact that a mid-ladder DCA was HELD despite an AI request. Never
  //    emits any ONYX CUT UI — engine simply moves on.
  for (const rc of decision.rejectedCloses ?? []) {
    await emitBotEvent(supabase, userId, "ONYX_CLOSE_REJECTED", {
      position_id: rc.positionId,
      wallet: rc.walletKey,
      symbol: rc.symbol,
      reason: rc.reason,
      detail: rc.detail,
      ai_rationale: rc.requestedRationale,
    }, "info");
  }


  // Reflect closes into perSymbol counts.
  for (const s of perSymbol) {
    const n = closedBySymbol.get(s.symbol) ?? 0;
    if (n > 0) s.closed = (s.closed ?? 0) + n;
  }


  // Dynamic-universe context: loaded lazily on the first approved candidate
  // when the gate is active. Any failure to load it fail-closes ALL approved
  // opens for this tick (no legacy fallback for dynamic_universe users).
  let dynamicCtx: DynamicOpenContext | null = null;
  let dynamicCtxLoaded = false;
  async function ensureDynamicCtx(): Promise<DynamicOpenContext | null> {
    if (dynamicCtxLoaded) return dynamicCtx;
    dynamicCtxLoaded = true;
    if (!universeGate.active || !universeGate.snapshotId) {
      return null;
    }
    dynamicCtx = await loadDynamicContext(supabase, userId, universeGate.snapshotId);
    if (!dynamicCtx) return null;
    // Idempotent pod seeding for the current (user, run_id) scope. Safe every
    // tick — the RPC no-ops when pods already exist. Failure is non-fatal; the
    // authority trigger will still reject opens if no pod becomes available.
    try {
      await ensurePodsForScope(supabase, {
        userId,
        connectionId: dynamicCtx.connectionId,
        exchange: dynamicCtx.exchange,
        environment: dynamicCtx.environment,
        marketType: dynamicCtx.marketType,
        runId: dynamicCtx.runId,
      });
    } catch { /* non-fatal — bind step will surface no_free_pod */ }
    return dynamicCtx;
  }

  const approvedKeys = new Set(decision.approved.map((a) => a.key));

  for (const rej of decision.rejected) {
    const c = rej.candidate;
    const outcome: EvalReason =
      rej.reason === "benched_wallet" ? "onyx_benched"
      : rej.reason === "correlated_over_exposure" ? "onyx_correlated"
      : rej.reason === "onyx_capacity" ? "onyx_capacity"
      : rej.reason === "onyx_held" ? "onyx_held"
      : "onyx_skipped";
    pushEval(c.symbol, c.direction, outcome,
      `${c.leg} rejected: ${rej.reason}`,
      c.trendState, c.trendSlopePct, 0);
    const legacyDecisionId = await persistOnyxDecision(
      c,
      rej.reason === "onyx_held" ? "hold" : "rejected",
      rej.reason,
      { leg: c.leg, regime: c.regime, rationale: `${c.leg} rejected by Onyx: ${rej.reason}`, key: c.key },
    );
    if (universeGate.active) {
      const ctx = await ensureDynamicCtx();
      if (ctx) {
        // For Scout-synthesized candidates, persist an onyx_decisions row
        // for every HOLD/REJECT so the durable decision ledger is complete
        // even when nothing executes. Correlation id links this decision to
        // the downstream paper_order_intent for full lineage.
        let onyxDecisionId: string | null = legacyDecisionId;
        const scoutMeta = scoutSignalByCandidateKey.get(c.key);
        if (c.leg === "scout" && scoutMeta) {
          const decisionRow = rej.reason === "onyx_held" ? "hold" : "rejected";
          const correlationId = crypto.randomUUID();
          const ins = await supabase
            .from("onyx_decisions")
            .insert({
              user_id: userId,
              correlation_id: correlationId,
              symbol: c.symbol,
              side: c.direction,
              decision: decisionRow,
              reject_reason: rej.reason,
              strategy: c.leg,
              scan_id: scoutMeta.scanId,
              envelope_version: ctx.envelopeVersion ?? 0,
              rules_version: RULES_VERSION,
              supporting_codes: [],
              conflicting_codes: [rej.reason],
              risk_check: {
                margin: c.margin,
                notional: c.notional,
                leverage: c.leverage,
                movement_score: c.movementScore,
              } as unknown as Database["public"]["Tables"]["onyx_decisions"]["Insert"]["risk_check"],
              signal_at: new Date(scoutMeta.createdAtMs).toISOString(),
              decision_at: new Date().toISOString(),
              decision_latency_ms: decisionLatencyMs,
              detail: {
                leg: c.leg,
                regime: c.regime,
                scout_signal_id: scoutMeta.signalId,
                rationale: `scout ${decisionRow} by onyx: ${rej.reason}`,
              } as unknown as Database["public"]["Tables"]["onyx_decisions"]["Insert"]["detail"],
            })
            .select("id")
            .single();
          if (!ins.error && ins.data) onyxDecisionId = ins.data.id as string;
        }
        await recordPaperOrderIntent(supabase, userId, ctx, {
          symbol: c.symbol,
          side: c.direction,
          strategy: c.leg,
          state: rej.reason === "onyx_held" ? "wait" : "rejected",
          reasonCode: rej.reason,
          reasonDetail: `${c.leg} rejected before execution`,
          margin: c.margin,
          notional: c.notional,
          leverage: c.leverage,
          onyxDecisionId,
          evidence: {
            key: c.key,
            movement_score: c.movementScore,
            leg: c.leg,
            // Lineage back to the originating scout_signals row when this
            // candidate was synthesized by Phase A.5.
            scout_signal_id: c.leg === "scout"
              ? c.openedFromSignal.split(":").pop() ?? null
              : null,
          },
        });
      }
    }
  }

  // ── Re-entry lockout ──────────────────────────────────────────────────
  //   After ANY Guardian-driven close (scout_bos, scout_guardian_bos,
  //   scout_guardian_cluster) on `(symbol, direction)`, block new entries on
  //   that same key for REENTRY_LOCKOUT_CANDLES (12) five-minute candles.
  //   Opposite direction is NEVER blocked; unrelated symbols are unaffected.
  //   Fetch a bounded window (2× lockout) so we never miss a fresh trigger.
  const lockoutNowMs = Date.now();
  const lockoutSinceIso = new Date(lockoutNowMs - 2 * REENTRY_LOCKOUT_MS).toISOString();
  const { data: lockoutTrades } = await supabase
    .from("paper_trades")
    .select("symbol, direction, exit_reason, closed_at")
    .eq("user_id", userId)
    .in("exit_reason", ["scout_bos", "scout_guardian_bos", "scout_guardian_cluster"])
    .gte("closed_at", lockoutSinceIso);
  const lockoutRows: LockoutTradeRow[] = (lockoutTrades ?? []).map((r) => ({
    symbol: String(r.symbol),
    direction: String(r.direction),
    exit_reason: String(r.exit_reason),
    closed_at_ms: new Date(r.closed_at as string).getTime(),
  }));
  const reentryLockout = buildLockoutSet(lockoutRows, lockoutNowMs);

  // ── Single authoritative allocator for this tick ──────────────────────
  //   Reconciles universe capacity (paper_execution_slots.maxNewEntries)
  //   with Onyx-approved throughput and prevents duplicate paper_positions
  //   on the same wallet or the same (symbol,direction) when a slot has
  //   just been refilled by a Phase-A close earlier in this same tick.
  //   Legacy (non-dynamic-universe) users bypass capacity checks by passing
  //   Number.POSITIVE_INFINITY and an empty allow-list.
  const allocator = new TickAllocator({
    maxNewEntries: universeGate.active
      ? (universeGate.capacity?.maxNewEntries ?? 0)
      : Number.POSITIVE_INFINITY,
    activeSymbols: universeGate.active ? (universeGate.capacity?.activeSymbols ?? []) : [],
    wallets: Array.from(walletsByKey.values()).map((w) => ({
      walletKey: w.wallet_key,
      balance: Number(w.balance) || 0,
      // Occupancy is tracked by allocator.openPositions at wallet+symbol
      // granularity; this compatibility flag is no longer authoritative.
      occupied: false,
    })),
    openPositions: Array.from(openBySlot.values()).map((p) => ({
      symbol: p.symbol,
      direction: p.direction as "long" | "short",
      walletKey: p.wallet_key,
    })),
    allowedNewEntries: universeGate.active ? universeGate.allowedNewEntries : new Set<string>(),
  });

  for (const approved of decision.approved) {
    const extras = candidateExtras.get(approved.key);
    if (!extras) continue;
    if (!approvedKeys.has(approved.key)) continue;
    // ── Re-entry lockout gate: same (symbol, direction) is blocked for
    //    REENTRY_LOCKOUT_CANDLES 5m candles after any Guardian-driven close.
    if (isLockedOut(reentryLockout, approved.symbol, approved.direction)) {
      pushEval(approved.symbol, approved.direction, "reentry_lockout",
        `blocked: guardian close on ${approved.symbol}:${approved.direction} within last ${REENTRY_LOCKOUT_CANDLES} candles`,
        approved.trendState, approved.trendSlopePct, 0);
      continue;
    }
    // Only the failed-alignment path requires Council→Onyx authority. Every
    // 2-of-3 core candidate bypasses AI regardless of detector strategy.
    const orch = orchestrationByKey.get(approved.key);
    const selectionPath = candidateSelectionPath.get(approved.key);
    if (selectionPath === "council_then_onyx" && (!orch || !orch.allowed)) {
      pushEval(approved.symbol, approved.direction, "onyx_skipped",
        `ai_orchestration_block:${orch?.blockedReason ?? "no_trace"}` +
        (orch ? ` (${orch.participation}; ${orch.onyxRationale})` : ""),
        approved.trendState, approved.trendSlopePct, 0);
      continue;
    }

    const currentWallet = walletsByKey.get(approved.walletKey) ?? extras.walletRow;
    // Refuse if this wallet+symbol slot acquired a position between Phase A
    // and C (would only happen with concurrent ticks — defensive).
    if (openBySlot.has(campaignSlotKey(approved.walletKey, approved.symbol))) {
      pushEval(approved.symbol, approved.direction, "position_open",
        "wallet became occupied before execute", approved.trendState, approved.trendSlopePct, 0);
      continue;
    }
    // ── Cross-margin guards: reject if this entry would push portfolio heat
    //    (Σ notional / equity) above MAX_HEAT, or if free margin cannot cover
    //    the position's margin requirement. Prevents new positions from
    //    triggering account-wide liquidation on the same tick.
    const mark = markPortfolio();
    if (mark.freeMargin < approved.margin) {
      pushEval(approved.symbol, approved.direction, "onyx_capacity",
        `insufficient free margin ($${mark.freeMargin.toFixed(2)} < $${approved.margin.toFixed(2)})`,
        approved.trendState, approved.trendSlopePct, 0);
      continue;
    }
    if (mark.equity > 0 && (mark.notional + approved.notional) > MAX_HEAT * mark.equity) {
      pushEval(approved.symbol, approved.direction, "onyx_capacity",
        `portfolio heat cap: notional ${(mark.notional + approved.notional).toFixed(0)} > ${MAX_HEAT}× equity ${mark.equity.toFixed(0)}`,
        approved.trendState, approved.trendSlopePct, 0);
      continue;
    }
    // ── Single authoritative allocator gate ─────────────────────────────
    //   Only path through which a paper_positions row may be opened this
    //   tick. Reserves the wallet slot + (symbol,direction) atomically so
    //   a later approval in the same tick — including one whose wallet was
    //   just refilled by a Phase-A close — cannot open a duplicate.
    const reservation = allocator.tryReserve({
      symbol: approved.symbol,
      direction: approved.direction,
      requiredMargin: approved.margin,
      preferredWalletKey: approved.walletKey,
      allowHedge: hedgeableSymbols.has(approved.symbol),
    });
    if (!reservation.ok) {
      pushEval(approved.symbol, approved.direction, "onyx_capacity",
        `allocator_reject:${reservation.reason}`,
        approved.trendState, approved.trendSlopePct, 0);
      continue;
    }
    const reservationToken: ReserveToken = reservation.token;
    // Entry fee is stored on the position row and subtracted at CLOSE via
    // pnl_net (grossPnl - exitFee - entryFee). We do NOT touch account
    // balance on open under cross margin.
    const ladderRungs = extras?.rungs ?? [];
    if (ladderRungs.length !== WALLET_CAMPAIGN_RUNG_COUNT) {
      pushEval(approved.symbol, approved.direction, "open_failed",
        `campaign must contain exactly ${WALLET_CAMPAIGN_RUNG_COUNT} rungs`,
        approved.trendState, approved.trendSlopePct, 0);
      allocator.release(reservationToken);
      continue;
    }
    const fallbackMarginPerRung = approved.margin / WALLET_CAMPAIGN_RUNG_COUNT;
    // FIX 1 (TP mismatch): for vanguard/accumulator, the strategy target
    // (approved.tpLevel) is the SINGLE source of truth for TP. Seed the
    // initial rung's per-lot tp from it so the exit loop honors the same
    // target the UI shows from tick 0. Other legs fall back to the DCA
    // rung TP as before.
    const _strategyTpSeed = (approved.leg === "vanguard" || approved.leg === "accumulator" || approved.leg === "sniper")
        && Number.isFinite(Number(approved.tpLevel)) && Number(approved.tpLevel) > 0
      ? Number(approved.tpLevel)
      : (approved.direction === "long"
          ? approved.fillPx * (1 + DCA_RUNG_TP_PCT)
          : approved.fillPx * (1 - DCA_RUNG_TP_PCT));
    const rung1 = ladderRungs[0] ?? {
      price: approved.fillPx, qty: approved.qty,
      margin: fallbackMarginPerRung,
      tp: _strategyTpSeed,
    };
    const pendingRungs = serializeRungs(ladderRungs.slice(1));
    // Store lot with per-lot margin + tp so the partial-reduce ladder can
    // scale out each lot independently at its own TP price.
    const initFills = [{
      price: rung1.price, qty: rung1.qty,
      margin: rung1.margin ?? fallbackMarginPerRung,
      tp: rung1.tp,
    }];
    // Persist every remaining rung at OPEN. Rung 1 is filled immediately;
    // rungs 2..N sit pending in both resize_levels and pending_rungs with
    // price, qty, wallet-compounded margin, and per-rung TP.
    const initResizeLevels = pendingRungs;
    // Atomic open via SECURITY DEFINER RPC (Phase 4B). Inserts the position
    // and updates paper_wallets.open_position_id in one transaction so a
    // partial failure cannot leave a wallet linked to a nonexistent position
    // or a position with no owning wallet slot.
    const openPayload = {
      wallet_key: approved.walletKey,
      symbol: approved.symbol,
      direction: approved.direction,
      entry_price: rung1.price,
      entry_ts: new Date(approved.entryCandleTs).toISOString(),
      entry_candle_ts_ms: approved.entryCandleTs,
      tp_level: approved.tpLevel,
      stop_level: approved.stopLevel,
      zone_lower: approved.zoneLower,
      zone_upper: approved.zoneUpper,
      zone_level: approved.zoneLevel,
      size_qty: rung1.qty,
      size_notional: rung1.qty * rung1.price,
      margin: approved.margin,
      leverage: approved.leverage,
      entry_fee: rung1.qty * rung1.price * MAKER_FEE_RATE,
      opened_from_signal: approved.openedFromSignal,
      last_seen_candle_ts_ms: approved.entryCandleTs,
      trend_at_entry: approved.trendState,
      trend_slope_pct_at_entry: approved.trendSlopePct,
      strategy: approved.leg,
      strategy_metadata: {
        detector_strategy: candidateDetector.get(approved.key) ?? approved.leg,
        ...(candidateExecutingTurtle.has(approved.key) ? {
          executing_turtle: candidateExecutingTurtle.get(approved.key),
        } : {}),
        ...(candidatePlan.has(approved.key) ? {
          autopilot_workflow_id: candidatePlan.get(approved.key)!.workflowId,
          autopilot_connection_id: candidatePlan.get(approved.key)!.connectionId,
        } : {}),
        ...(approved.leg === "sweep" ? {
            contract_id: ZEN_SWEEP.strategy_id,
            first_target_taken: false,
            banked_net_pnl: 0,
            high_water_net_roi_pct: null,
            trailing_floor_net_roi_pct: null,
          }
        : {
            selection_path: candidateSelectionPath.get(approved.key) ?? "core_2_of_3",
          }),
      },
      regime_at_entry: approved.regime,
      onyx_rationale: approved.rationale,
      // Bind the exact orchestration that approved this candidate. The DB
      // trigger remains the final fail-closed authority, but must not guess by
      // searching recent rows: concurrent/repeated committee runs can make the
      // newest row a WAIT even when this in-memory result is an approved ENTER.
      orchestration_trace_id: orch?.traceId ?? null,
      rung_count: 1,
      first_fill_vwap: rung1.price,
      fills: initFills,
      resize_levels: initResizeLevels,
      pending_rungs: pendingRungs,
      ladder_total_margin: approved.margin,
      ladder_total_notional: approved.notional,
      ladder_total_rungs: ladderRungs.length,
      // For ladder/DCA strategies, the RPC forces stop_level=NULL on insert
      // so a preplanned deepest-rung price cannot masquerade as an armed
      // strategy stop. The stop_level is only populated later on the tick
      // that completes the ladder (see armLadderHardStop / buildArmingPayload).
      ladder_strategy: isLadderPosition({
        strategy: approved.leg,
        ladder_total_rungs: ladderRungs.length,
      }),

    };
    const openOpKey = `open:${approved.walletKey}:${approved.symbol}:${approved.direction}:${approved.entryCandleTs}`;
    const openFp = await fingerprintPayload(openPayload);
    let newPositionId: string;
    // Legacy paper open path is authoritative while the dynamic-universe
    // execution pipeline is rolled back. Do not branch into `openDynamic` here:
    // production still had fresh approvals getting rejected with
    // `dynamic_ctx_missing`, which meant Onyx approved trades but no
    // paper_positions rows were inserted.
    const openRes = await repoOpenPosition(supabase, {
      userId,
      walletId: currentWallet.id,
      payload: openPayload as unknown as Record<string, unknown>,
      opKey: openOpKey,
      fingerprint: openFp,
    });
    if (!openRes.result.ok) {
      allocator.release(reservationToken);
      pushEval(approved.symbol, approved.direction, "open_failed",
        `atomic open failed:${openRes.result.reason}${openRes.result.detail ? `(${openRes.result.detail})` : ""}${openRes.result.reconciliationRequired ? ":reconcile" : ""}`,
        approved.trendState, approved.trendSlopePct, 0);
      continue;
    }
    newPositionId = (openRes.result.value as { position_id: string }).position_id;
    await persistOnyxDecision(approved, "approved", null, {
      leg: approved.leg,
      regime: approved.regime,
      rationale: approved.rationale,
      key: approved.key,
      position_id: newPositionId,
    });
    // Load the fresh row so downstream Phase C state (openBySlot map,
    // walletsByKey map) stays consistent with the DB.
    const { data: inserted } = await supabase.from("paper_positions")
      .select("*").eq("id", newPositionId).maybeSingle();
    const { data: updated } = await supabase.from("paper_wallets")
      .select("*").eq("id", currentWallet.id).maybeSingle();
    if (updated) walletsByKey.set(approved.walletKey, updated);
    if (inserted) openBySlot.set(campaignSlotKey(approved.walletKey, approved.symbol), inserted);
    openedBySymbol.set(approved.symbol, (openedBySymbol.get(approved.symbol) ?? 0) + 1);
    // Onyx→Scout HANDOFF: fresh open. Scout will guard this position on the
    // next tick using its protective structural swing.
    await emitBotEvent(supabase, userId, "ONYX_HANDOFF", {
      position_id: newPositionId,
      symbol: approved.symbol,
      direction: approved.direction,
      avg_entry: rung1.price,
      rungs_filled: 1,
      trigger: "open",
      leg: approved.leg,
    });
    pushEval(approved.symbol, approved.direction, "opened",
      `${approved.leg} onyx#${approved.priority}: ${approved.rationale}`,
      approved.trendState, approved.trendSlopePct, 0);
  }

  // Backfill opened counts on perSymbol from executed candidates.
  for (const p of perSymbol) {
    const n = openedBySymbol.get(p.symbol) ?? 0;
    if (n > 0) p.opened = (p.opened ?? 0) + n;
  }

  // Aggregate one PAPER_TICK_REASONS row for this whole tick so the reasons
  // are queryable without hammering bot_events with per-eval inserts.
  const buckets: Record<string, number> = {};
  for (const e of evaluations) buckets[e.outcome] = (buckets[e.outcome] ?? 0) + 1;
  await emitBotEvent(supabase, userId, "PAPER_TICK_REASONS", {
    buckets,
    evaluations: evaluations.map((e) => ({ ...e })),
    per_symbol: perSymbol.map((p) => ({
      symbol: p.symbol, opened: p.opened, closed: p.closed,
      trend: p.trend ?? null, slope_pct: p.trendSlopePct ?? null,
      regime: p.regime ?? null, armed_leg: p.armedLeg ?? null,
      blocked_long: p.blockedLong ?? 0, blocked_short: p.blockedShort ?? 0,
      error: p.error ?? null,
    })),
    onyx: {
      candidates: candidates.length,
      approved: decision.approved.length,
      rejected: decision.rejected.length,
      ai_called: decision.aiCalled,
      ai_error: decision.aiError,
      used_fallback: decision.usedFallback,
      narrative: decision.narrative,
      skip_reason: decision.skipReason,
      fleet: {
        free: freeWalletCount, open: openCount, alt_open: altOpenCount,
        benched: benchedWallets,
      },
      approved_keys: decision.approved.map((a) => ({
        key: a.key, priority: a.priority, rationale: a.rationale,
      })),
    },
  });

  // Cross-margin bookkeeping (balance + cumulative realized PnL) is applied
  // atomically inside each `paper_close_position` / `paper_reduce_position`
  // RPC alongside the trade insert and position flip. Do NOT double-write
  // paper_accounts here — `accountBalance` / `realizedDelta` are local
  // mirrors kept in sync so downstream markPortfolio() and the aggregated
  // liquidation loop above see consistent state within one tick.



  return {
    ranAt: Date.now(),
    perSymbol,
    evaluations,
    onyx: {
      candidates: candidates.length,
      approved: decision.approved.length,
      rejected: decision.rejected.length,
      aiCalled: decision.aiCalled,
      aiError: decision.aiError,
      usedFallback: decision.usedFallback,
      narrative: decision.narrative,
      skipReason: decision.skipReason,
    },
  };
}
