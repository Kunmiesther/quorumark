/**
 * Pure helpers for the Bot View charts.
 *
 * NO React, NO Supabase, NO I/O — deterministic transforms only so they can
 * be unit-tested and reused by the equity curve, per-position chart, and any
 * future surface (report exports, admin panels).
 */

export type EquityTrade = {
  closed_at: string;
  pnl_net: number | string | null;
};

export type EquityPoint = { t: number; equity: number };

/**
 * Cumulative account equity series from realized paper trades.
 * - Starts at `baseEquity` at the earliest trade close (t - 1ms).
 * - Honesty: losses REDUCE equity; there is no clamping to zero and no
 *   floor. Losing streaks visibly drag the curve down.
 * - Downsamples to at most `maxPoints` samples (default 300) by uniform
 *   index stride, always keeping the first and last points.
 */
export function deriveEquitySeries(
  trades: EquityTrade[],
  baseEquity: number,
  maxPoints = 300,
): EquityPoint[] {
  const rows = [...trades]
    .filter((t) => !!t.closed_at)
    .sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime());
  if (rows.length === 0) return [];
  let cum = baseEquity;
  const raw: EquityPoint[] = [
    { t: new Date(rows[0].closed_at).getTime() - 1, equity: cum },
  ];
  for (const r of rows) {
    cum += Number(r.pnl_net ?? 0);
    raw.push({ t: new Date(r.closed_at).getTime(), equity: cum });
  }
  return downsample(raw, maxPoints);
}

function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const stride = arr.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(arr[Math.floor(i * stride)]);
  }
  // Ensure last point is always the true last sample.
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

// ---- Target lines -------------------------------------------------------

export type TargetKind = "tp" | "stop" | "rung" | "be_stop" | "htf_structure";

export type TargetLine = {
  label: string;
  price: number;
  kind: TargetKind;
  color: string;
};

export type TargetPosition = {
  direction: "long" | "short" | string;
  tp_level?: number | null;
  stop_level?: number | null;
  pending_rungs?: Array<{ price: number | string }> | null;
  promoted?: boolean | null;
  runner_breakeven_stop?: number | null;
  htf_structure_level?: number | null;
};

const COLOR_TP = "#14F195";
const COLOR_STOP = "#ff5c8a";
const COLOR_RUNG = "#9945FF";
const COLOR_BE = "#e8b73a";
const COLOR_HTF = "#4dd0ff";

/**
 * Extract horizontal target reference lines for a position.
 * - Non-promoted: TP + STOP + each unfilled RUNG.
 * - Promoted (runner): HIDES TP (it was cancelled on promotion) and hides
 *   unfilled rungs (also cancelled). Shows BE STOP and 1H STRUCTURE.
 */
export function deriveTargetLines(pos: TargetPosition): TargetLine[] {
  const out: TargetLine[] = [];
  const promoted = !!pos.promoted;

  if (!promoted && pos.tp_level != null && Number(pos.tp_level) > 0) {
    out.push({ label: "TP", price: Number(pos.tp_level), kind: "tp", color: COLOR_TP });
  }

  if (pos.stop_level != null && Number(pos.stop_level) > 0 && !promoted) {
    out.push({ label: "STOP", price: Number(pos.stop_level), kind: "stop", color: COLOR_STOP });
  }

  if (!promoted && Array.isArray(pos.pending_rungs)) {
    pos.pending_rungs.forEach((r, i) => {
      const p = Number(r?.price);
      if (Number.isFinite(p) && p > 0) {
        out.push({ label: `RUNG ${i + 2}`, price: p, kind: "rung", color: COLOR_RUNG });
      }
    });
  }

  if (promoted && pos.runner_breakeven_stop != null && Number(pos.runner_breakeven_stop) > 0) {
    out.push({
      label: "BE STOP",
      price: Number(pos.runner_breakeven_stop),
      kind: "be_stop",
      color: COLOR_BE,
    });
  }

  if (promoted && pos.htf_structure_level != null && Number(pos.htf_structure_level) > 0) {
    out.push({
      label: "1H STRUCTURE",
      price: Number(pos.htf_structure_level),
      kind: "htf_structure",
      color: COLOR_HTF,
    });
  }

  return out;
}
