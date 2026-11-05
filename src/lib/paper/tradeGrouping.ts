/**
 * Group paper_trades rows by parent ladder (position_id) for presentation.
 * Pure, deterministic, no I/O. Presentation only — does not touch engine.
 *
 * A single laddered close produces one paper_trades row per filled rung
 * (see paper_close_position RPC). Rendering each rung as an independent
 * "trade" misrepresents win-rate, trade count, and exit reasons. This
 * helper collapses same-parent rungs into one GroupedTrade with a per-rung
 * breakdown, and maps the stored exit_reason code to a precise label.
 */
export interface RawPaperTrade {
  id: string;
  position_id: string | null;
  wallet_key: string;
  symbol: string;
  direction: string;
  entry_price: number | string;
  exit_price: number | string;
  exit_reason: string;
  size_qty: number | string;
  size_notional: number | string;
  margin: number | string;
  pnl_gross: number | string | null;
  pnl_net: number | string;
  fees: number | string;
  opened_at: string;
  closed_at: string;
}

export interface GroupedRung {
  id: string;
  entry_price: number;
  exit_price: number;
  size_qty: number;
  size_notional: number;
  margin: number;
  pnl_gross: number;
  fees: number;
  pnl_net: number;
}

export interface GroupedTrade {
  key: string;                 // position_id, or `orphan:<trade.id>` when null
  position_id: string | null;
  wallet_key: string;
  symbol: string;
  direction: string;
  rung_count: number;
  weighted_entry: number;      // notional-weighted average entry
  exit_price: number;          // shared exit across the ladder
  total_margin: number;
  total_notional: number;
  total_gross: number;
  total_fees: number;
  total_net: number;
  exit_reason: string;         // authoritative stored code
  opened_at: string;           // earliest opened_at
  closed_at: string;           // latest closed_at
  rungs: GroupedRung[];        // sorted by entry_price (long: desc, short: asc)
}

const n = (v: number | string | null | undefined): number =>
  v == null ? 0 : typeof v === "number" ? v : Number(v);

/**
 * Group by parent position_id. Rows without a position_id remain individual
 * (keyed as `orphan:<id>`) so pre-ladder legacy trades still render.
 * Never groups by symbol/time alone.
 */
export function groupPaperTrades(rows: RawPaperTrade[]): GroupedTrade[] {
  const byKey = new Map<string, RawPaperTrade[]>();
  for (const r of rows) {
    const key = r.position_id ?? `orphan:${r.id}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }

  const out: GroupedTrade[] = [];
  for (const [key, group] of byKey) {
    const rungs: GroupedRung[] = group.map((r) => ({
      id: r.id,
      entry_price: n(r.entry_price),
      exit_price: n(r.exit_price),
      size_qty: n(r.size_qty),
      size_notional: n(r.size_notional),
      margin: n(r.margin),
      pnl_gross: n(r.pnl_gross),
      fees: n(r.fees),
      pnl_net: n(r.pnl_net),
    }));

    const first = group[0];
    const direction = first.direction;
    // Long ladders average DOWN — show deepest last (asc entry desc? use engine order):
    // sort by entry_price so longs are descending (top rung first), shorts ascending.
    rungs.sort((a, b) =>
      direction === "short" ? a.entry_price - b.entry_price : b.entry_price - a.entry_price,
    );

    const total_notional = rungs.reduce((s, r) => s + r.size_notional, 0);
    const total_margin = rungs.reduce((s, r) => s + r.margin, 0);
    const total_gross = rungs.reduce((s, r) => s + r.pnl_gross, 0);
    const total_fees = rungs.reduce((s, r) => s + r.fees, 0);
    const total_net = rungs.reduce((s, r) => s + r.pnl_net, 0);
    const weighted_entry =
      total_notional > 0
        ? rungs.reduce((s, r) => s + r.entry_price * r.size_notional, 0) / total_notional
        : rungs[0]?.entry_price ?? 0;

    const opened_at = group.reduce(
      (min, r) => (r.opened_at < min ? r.opened_at : min),
      group[0].opened_at,
    );
    const closed_at = group.reduce(
      (max, r) => (r.closed_at > max ? r.closed_at : max),
      group[0].closed_at,
    );

    out.push({
      key,
      position_id: first.position_id,
      wallet_key: first.wallet_key,
      symbol: first.symbol,
      direction,
      rung_count: rungs.length,
      weighted_entry,
      exit_price: n(first.exit_price),
      total_margin,
      total_notional,
      total_gross,
      total_fees,
      total_net,
      exit_reason: first.exit_reason,
      opened_at,
      closed_at,
      rungs,
    });
  }

  out.sort((a, b) => (a.closed_at < b.closed_at ? 1 : -1));
  return out;
}

/**
 * Authoritative exit-reason label. Maps stored codes to precise UI text.
 * Unknown codes are surfaced verbatim (uppercased, underscores→spaces) —
 * never lie by falling back to a generic "STOP".
 */
export function exitReasonLabel(code: string): {
  label: string;
  tone: "positive" | "negative" | "warn" | "neutral";
} {
  switch (code) {
    case "tp_touch":
    case "tp":
    case "tp_limit":
      return { label: "TAKE PROFIT", tone: "positive" };
    case "stop":
    case "hard_stop":
      return { label: "HARD STOP", tone: "negative" };
    case "trailing_stop":
    case "trailing":
      return { label: "TRAILING STOP", tone: "negative" };
    case "scout_bos":
    case "scout_invalidation":
      return { label: "SCOUT INVALIDATION", tone: "warn" };
    case "scout_guardian_bos":
      return { label: "GUARDIAN · BOS", tone: "warn" };
    case "scout_guardian_cluster":
      return { label: "GUARDIAN · CLUSTER", tone: "warn" };
    case "htf_bos_exit":
      return { label: "HTF BOS · RUNNER CLOSED", tone: "neutral" };
    case "runner_breakeven_stop":
      return { label: "RUNNER · BREAKEVEN STOP", tone: "neutral" };
    case "onyx_cut":
      return { label: "ONYX CUT", tone: "warn" };
    case "onyx_close":
    case "onyx_bank":
      return { label: "ONYX CLOSE", tone: "warn" };
    case "liquidation":
    case "liq_guard":
      return { label: "LIQUIDATION GUARD", tone: "negative" };
    case "strategy_invalidation":
    case "invalidation":
      return { label: "STRATEGY INVALIDATION", tone: "warn" };
    case "kill_switch":
      return { label: "KILL SWITCH", tone: "negative" };
    case "manual":
      return { label: "MANUAL", tone: "neutral" };
    default:
      return { label: code.replace(/_/g, " ").toUpperCase(), tone: "neutral" };
  }
}
