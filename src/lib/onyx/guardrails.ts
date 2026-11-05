/**
 * Onyx deterministic guardrails.
 *
 * These are HARD CODE — the AI reasoning layer cannot reason past them.
 * Applied BEFORE the model sees the option set. Anything filtered here
 * never becomes a recommendation, period.
 *
 * Pure functions; no I/O; report-only (does not touch execution).
 */

import type { ScoutReport } from "@/hooks/useScout";
import type { Direction, TurtleRec } from "@/lib/scout/scoring";
import { ORCHESTRATION } from "@/lib/paper/parityConstants";

export interface OpenPosSummary {
  wallet_key: string;
  symbol: string;
  direction: "long" | "short";
}

export interface WalletSummary {
  wallet_key: string;
  balance: number;
  floor_hit: boolean;
  open_position_id: string | null;
}

export interface RecentTradeSummary {
  wallet_key: string;
  exit_reason: string; // "stop" | "tp" | "manual" | ...
  closed_at: string;
}

export interface FleetState {
  wallets: WalletSummary[];
  openPositions: OpenPosSummary[];
  recentTrades: RecentTradeSummary[]; // most-recent-first, per wallet
}

export interface OnyxOption {
  symbol: string;
  base: string;
  turtle: Exclude<TurtleRec, "sit-out">;
  direction: Exclude<Direction, "neutral">;
  movement: number;
  volatility: number | null;
  trendStrength: number | null;
  momentum: number | null;
  trend: string;
  candidateWalletKey: string; // wallet_key that would host it
}

export type FilteredReason =
  | "sit_out"
  | "no_movement"
  | "no_wallet_free"
  | "wallet_floor_hit"
  | "benched_consecutive_stops"
  | "counter_trend"
  | "correlated_over_exposure"
  | "duplicate_side_open";

export interface FilteredOption {
  symbol: string;
  base: string;
  reason: FilteredReason;
  detail: string;
}

export interface GuardrailConfig {
  /** consecutive stops on a wallet_key -> bench that side */
  benchConsecutiveStops: number;
  /** min composite movement score to consider */
  movementFloor: number;
  /** cap on total open positions across the whole fleet */
  maxTotalOpen: number;
  /** cap on how many alt (non-BTC/ETH) positions may be open at once */
  maxAltPositions: number;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  benchConsecutiveStops: 3,
  movementFloor: 30,
  maxTotalOpen: ORCHESTRATION.max_active_opportunities,
  maxAltPositions: ORCHESTRATION.max_active_opportunities,
};

const ANCHORS = new Set(["BTC", "ETH"]);

function baseOf(sym: string): string {
  const i = sym.indexOf("-");
  return i > 0 ? sym.slice(0, i) : sym;
}

/** Four-wallet convention: every symbol shares the Long or Short role wallet. */
function walletKeyFor(_base: string, direction: "long" | "short"): string {
  return direction;
}

/** Count consecutive stops at the head of recentTrades for a given wallet_key. */
function consecutiveStops(trades: RecentTradeSummary[], walletKey: string): number {
  let n = 0;
  for (const t of trades) {
    if (t.wallet_key !== walletKey) continue;
    if (t.exit_reason === "stop") n++;
    else break;
  }
  return n;
}

export interface GuardrailResult {
  options: OnyxOption[];
  filtered: FilteredOption[];
  benchedWallets: string[];
  freeWalletCount: number;
  openCount: number;
  altOpenCount: number;
  config: GuardrailConfig;
}

/**
 * Apply guardrails to the Scout report + fleet state. Returns:
 *   - options: what Claude/the model is ALLOWED to reason over
 *   - filtered: everything blocked, with a code + explanation
 *   - benchedWallets: wallet_keys locked out this cycle
 */
export function applyGuardrails(
  reports: ScoutReport[],
  fleet: FleetState,
  cfg: GuardrailConfig = DEFAULT_GUARDRAILS,
): GuardrailResult {
  const openSlots = new Set<string>();
  for (const p of fleet.openPositions) openSlots.add(`${p.wallet_key}:${p.symbol}`);

  const walletByKey = new Map<string, WalletSummary>();
  for (const w of fleet.wallets) walletByKey.set(w.wallet_key, w);

  // Bench any wallet with >= benchConsecutiveStops consecutive stops.
  const benched = new Set<string>();
  const walletKeys = new Set<string>([
    ...fleet.wallets.map((w) => w.wallet_key),
    ...fleet.recentTrades.map((t) => t.wallet_key),
  ]);
  for (const wk of walletKeys) {
    if (consecutiveStops(fleet.recentTrades, wk) >= cfg.benchConsecutiveStops) {
      benched.add(wk);
    }
  }

  const openCount = fleet.openPositions.length;
  const altOpenCount = fleet.openPositions.filter(
    (p) => !ANCHORS.has(baseOf(p.symbol)),
  ).length;

  const options: OnyxOption[] = [];
  const filtered: FilteredOption[] = [];

  const capacityLeft = Math.max(0, cfg.maxTotalOpen - openCount);
  const altCapacityLeft = Math.max(0, cfg.maxAltPositions - altOpenCount);

  for (const r of reports) {
    const base = baseOf(r.symbol);
    const s = r.signal?.scores;
    if (!s || s.recommendation === "sit-out" || s.direction === "neutral") {
      filtered.push({
        symbol: r.symbol,
        base,
        reason: "sit_out",
        detail: s
          ? `Scout: ${s.recommendation} / ${s.direction}`
          : "no scout signal",
      });
      continue;
    }
    if (s.movement == null || s.movement < cfg.movementFloor) {
      filtered.push({
        symbol: r.symbol,
        base,
        reason: "no_movement",
        detail: `movement ${s.movement?.toFixed(0) ?? "n/a"} < floor ${cfg.movementFloor}`,
      });
      continue;
    }
    // Accumulator: must be trend-aligned. Hunter is exempt (volatility specialist).
    if (
      s.recommendation === "accumulator" &&
      ((s.direction === "long" && s.trend !== "up") ||
        (s.direction === "short" && s.trend !== "down"))
    ) {
      filtered.push({
        symbol: r.symbol,
        base,
        reason: "counter_trend",
        detail: `Accumulator ${s.direction} vs trend ${s.trend}`,
      });
      continue;
    }
    const direction = s.direction as "long" | "short";
    const wk = walletKeyFor(base, direction);
    if (benched.has(wk)) {
      filtered.push({
        symbol: r.symbol,
        base,
        reason: "benched_consecutive_stops",
        detail: `${wk} benched (≥${cfg.benchConsecutiveStops} consecutive stops)`,
      });
      continue;
    }
    const wallet = walletByKey.get(wk);
    if (!wallet) {
      filtered.push({
        symbol: r.symbol,
        base,
        reason: "no_wallet_free",
        detail: `no paper wallet for ${wk}`,
      });
      continue;
    }
    if (wallet.floor_hit) {
      filtered.push({
        symbol: r.symbol,
        base,
        reason: "wallet_floor_hit",
        detail: `${wk} at $500 floor`,
      });
      continue;
    }
    if (openSlots.has(`${wk}:${r.symbol}`)) {
      filtered.push({
        symbol: r.symbol,
        base,
        reason: "duplicate_side_open",
        detail: `${wk} already has an open position`,
      });
      continue;
    }
    if (capacityLeft <= 0) {
      filtered.push({
        symbol: r.symbol,
        base,
        reason: "no_wallet_free",
        detail: `fleet at max ${cfg.maxTotalOpen} open`,
      });
      continue;
    }
    if (!ANCHORS.has(base) && altCapacityLeft <= 0) {
      filtered.push({
        symbol: r.symbol,
        base,
        reason: "correlated_over_exposure",
        detail: `alt cap ${cfg.maxAltPositions} reached`,
      });
      continue;
    }

    options.push({
      symbol: r.symbol,
      base,
      turtle: s.recommendation as "hunter" | "accumulator",
      direction,
      movement: s.movement,
      volatility: s.volatility,
      trendStrength: s.trendStrength,
      momentum: s.momentum,
      trend: s.trend,
      candidateWalletKey: wk,
    });
  }

  // Deterministic priority order presented to the model:
  // highest movement first, ties broken by trend strength.
  options.sort((a, b) => {
    if (b.movement !== a.movement) return b.movement - a.movement;
    return (b.trendStrength ?? 0) - (a.trendStrength ?? 0);
  });

  const freeWalletCount = fleet.wallets.filter(
    (w) => !w.floor_hit && !benched.has(w.wallet_key),
  ).length;

  return {
    options,
    filtered,
    benchedWallets: Array.from(benched).sort(),
    freeWalletCount,
    openCount,
    altOpenCount,
    config: cfg,
  };
}
