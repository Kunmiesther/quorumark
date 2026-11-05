/**
 * BTC/ETH DCA context — PURE reducer for the read-only Scout view of the
 * 8-rung Accumulator contract. Never mutates trading state.
 *
 * Canonical symbols: exactly BTC-USDT and ETH-USDT.
 *
 * Contract (persisted paper_positions):
 *  - 100x leverage
 *  - planned total margin: $60
 *  - 8 rungs × $7.50
 *  - 1% adverse span inclusive across the full ladder
 *  - each filled rung's TP = 1% from that rung's actual fill price
 *  - strategy stop only armed after actual rung-8 fill, 1% beyond that fill
 *
 * If persisted data disagrees with contract, return CONTRACT_MISMATCH with the
 * list of mismatched fields; do not normalize/rewrite state.
 *
 * READ-ONLY MODULE.
 */

export const DCA_CANONICAL_SYMBOLS = ["BTC-USDT", "ETH-USDT"] as const;
export type DcaCanonicalSymbol = (typeof DCA_CANONICAL_SYMBOLS)[number];

export const DCA_CONTRACT = {
  leverage: 100,
  planned_margin_usd: 60,
  planned_rungs: 8,
  planned_per_rung_margin_usd: 7.5,
  adverse_span_pct: 0.01,
  per_rung_tp_pct: 0.01,
  final_stop_beyond_rung_pct: 0.01,
} as const;

export type DcaContextStatus =
  | "NO_POSITION"
  | "ACTIVE"
  | "CONTRACT_MISMATCH"
  | "NOT_CANONICAL_SYMBOL";

export interface RungInfo {
  index: number;      // 1..8
  level: number;      // planned or actual fill price
  filled: boolean;
  tp_level: number | null; // 1% from fill; null when not filled
  tp_hit: boolean;
}

export interface DcaContext {
  symbol: DcaCanonicalSymbol;
  status: DcaContextStatus;
  direction: "long" | "short" | null;
  filled_rungs: number;
  pending_rungs: number;
  remaining_planned_margin_usd: number;
  next_rung: { index: number; level: number; distance_pct: number } | null;
  per_rung_tps: RungInfo[];
  tp_hit_count: number;
  final_stop_armed: boolean;
  final_stop_level: number | null;
  liquidation_buffer_pct: number | null;
  mismatched_fields: string[];
  contract: typeof DCA_CONTRACT;
}

/** Position row shape we consume — narrowed subset of paper_positions. */
export interface PaperPositionRow {
  symbol: string;
  direction: "long" | "short";
  status: string;
  leverage: number;
  margin: number;
  entry_price: number;
  strategy: string;
  rung_count: number;
  ladder_total_margin: number | null;
  ladder_total_rungs: number | null;
  fills: unknown;          // jsonb: array of { price, qty, margin }
  pending_rungs: unknown;  // jsonb: array of { level, margin }
  resize_levels: unknown;  // jsonb
  stop_level: number | null;
  tp_level: number | null;
}

interface FillRow { price: number; margin?: number }
interface PendingRow { level: number; margin?: number }

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function isCanonical(symbol: string): symbol is DcaCanonicalSymbol {
  return (DCA_CANONICAL_SYMBOLS as readonly string[]).includes(symbol);
}

export function noPositionContext(symbol: DcaCanonicalSymbol): DcaContext {
  return {
    symbol,
    status: "NO_POSITION",
    direction: null,
    filled_rungs: 0,
    pending_rungs: 0,
    remaining_planned_margin_usd: DCA_CONTRACT.planned_margin_usd,
    next_rung: null,
    per_rung_tps: [],
    tp_hit_count: 0,
    final_stop_armed: false,
    final_stop_level: null,
    liquidation_buffer_pct: null,
    mismatched_fields: [],
    contract: DCA_CONTRACT,
  };
}

/**
 * Build DCA context from an authoritative persisted paper_positions row.
 * Pass `lastPrice` optionally to compute distances/liquidation buffer.
 */
export function buildDcaContext(
  symbol: string,
  row: PaperPositionRow | null,
  lastPrice?: number | null,
): DcaContext {
  if (!isCanonical(symbol)) {
    return {
      ...noPositionContext(symbol as DcaCanonicalSymbol),
      symbol: symbol as DcaCanonicalSymbol,
      status: "NOT_CANONICAL_SYMBOL",
    };
  }
  if (!row) return noPositionContext(symbol);

  const mismatched: string[] = [];
  if (row.leverage !== DCA_CONTRACT.leverage) mismatched.push("leverage");
  if (row.strategy !== "accumulator" && row.strategy !== "dca") mismatched.push("strategy");
  const plannedRungs = row.ladder_total_rungs ?? DCA_CONTRACT.planned_rungs;
  if (plannedRungs !== DCA_CONTRACT.planned_rungs) mismatched.push("ladder_total_rungs");
  const plannedMargin = row.ladder_total_margin ?? DCA_CONTRACT.planned_margin_usd;
  if (Math.abs(plannedMargin - DCA_CONTRACT.planned_margin_usd) > 0.5) {
    mismatched.push("ladder_total_margin");
  }

  const fills = asArray<FillRow>(row.fills);
  const pending = asArray<PendingRow>(row.pending_rungs);
  const filledCount = fills.length;
  const pendingCount = pending.length;

  if (filledCount + pendingCount > DCA_CONTRACT.planned_rungs) {
    mismatched.push("rung_count_total");
  }

  const perRungTps: RungInfo[] = [];
  const isLong = row.direction === "long";
  for (let i = 0; i < filledCount; i++) {
    const f = fills[i];
    const tp = isLong ? f.price * (1 + DCA_CONTRACT.per_rung_tp_pct)
                       : f.price * (1 - DCA_CONTRACT.per_rung_tp_pct);
    const hit = lastPrice != null && (isLong ? lastPrice >= tp : lastPrice <= tp);
    perRungTps.push({
      index: i + 1,
      level: f.price,
      filled: true,
      tp_level: tp,
      tp_hit: hit,
    });
  }
  for (let i = 0; i < pendingCount; i++) {
    const p = pending[i];
    perRungTps.push({
      index: filledCount + i + 1,
      level: p.level,
      filled: false,
      tp_level: null,
      tp_hit: false,
    });
  }

  let nextRung: DcaContext["next_rung"] = null;
  if (pending.length && lastPrice != null && lastPrice > 0) {
    const p = pending[0];
    const distance = Math.abs(p.level - lastPrice) / lastPrice;
    nextRung = { index: filledCount + 1, level: p.level, distance_pct: distance };
  }

  const finalStopArmed = filledCount >= DCA_CONTRACT.planned_rungs;
  let finalStopLevel: number | null = null;
  if (finalStopArmed) {
    const lastFill = fills[fills.length - 1];
    if (lastFill?.price) {
      finalStopLevel = isLong
        ? lastFill.price * (1 - DCA_CONTRACT.final_stop_beyond_rung_pct)
        : lastFill.price * (1 + DCA_CONTRACT.final_stop_beyond_rung_pct);
      if (row.stop_level && Math.abs(row.stop_level - finalStopLevel) / lastFill.price > 0.005) {
        mismatched.push("stop_level");
      }
    }
  }

  let liqBuffer: number | null = null;
  if (lastPrice != null && row.entry_price > 0 && row.leverage > 0) {
    const liqDistPct = 1 / row.leverage;
    const currentPnlPct = isLong
      ? (lastPrice - row.entry_price) / row.entry_price
      : (row.entry_price - lastPrice) / row.entry_price;
    liqBuffer = liqDistPct + currentPnlPct;
  }

  const tpHitCount = perRungTps.filter((r) => r.tp_hit).length;
  const remainingMargin = Math.max(
    0,
    DCA_CONTRACT.planned_margin_usd - filledCount * DCA_CONTRACT.planned_per_rung_margin_usd,
  );

  return {
    symbol,
    status: mismatched.length ? "CONTRACT_MISMATCH" : "ACTIVE",
    direction: row.direction,
    filled_rungs: filledCount,
    pending_rungs: pendingCount,
    remaining_planned_margin_usd: remainingMargin,
    next_rung: nextRung,
    per_rung_tps: perRungTps,
    tp_hit_count: tpHitCount,
    final_stop_armed: finalStopArmed,
    final_stop_level: finalStopLevel,
    liquidation_buffer_pct: liqBuffer,
    mismatched_fields: mismatched,
    contract: DCA_CONTRACT,
  };
}
