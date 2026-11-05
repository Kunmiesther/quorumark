/**
 * ENVIRONMENT TIMEFRAMES (1d / 1w / 1M) — real data, not "unavailable".
 *
 * Owner directive (timeframe completeness): the model prompt must not keep
 * claiming daily/weekly/monthly context is unavailable simply because the
 * paper engine's own 5m feed window is ~16h wide. These frames are fetched
 * directly from the ApeX public klines endpoint, which serves native D/W/M
 * intervals — no approximation, no folding of 5m bars.
 *
 * AUTHORITY: advisory only. Nothing here can approve, block, size or alter a
 * trade. A fetch failure degrades this block to `available: false` with a
 * stable reason and must NEVER fail a candidate — the entry-timeframe
 * snapshot validator (`validateMarketSnapshot`) is the only data gate.
 */

const APEX_OMNI_HTTP = "https://omni.apex.exchange";
const KLINES_PATH = "/api/v3/klines";

/** ApeX native interval tokens for the environment frames. */
const FRAME_TOKENS = { "1d": "D", "1w": "W", "1M": "M" } as const;
export type EnvironmentFrame = keyof typeof FRAME_TOKENS;

/** How long a fetched environment block stays reusable, per symbol. */
export const ENV_FRAME_TTL_MS = 15 * 60_000;

export interface EnvironmentFrameSummary {
  /** Close time of the newest COMPLETED bar on this frame, epoch ms. */
  last_closed_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Close-over-close change vs the previous completed bar, percent. */
  change_pct: number | null;
  /** "up" | "down" | "flat" from close vs previous close. Null with <2 bars. */
  direction: "up" | "down" | "flat" | null;
  /** Where `close` sits inside this bar's range, 0..1. Null for a zero range. */
  range_position: number | null;
  /** Completed bars used to derive this summary. */
  bars: number;
}

export interface EnvironmentContext {
  available: boolean;
  /** Stable machine reason when `available` is false. */
  unavailable_reason: string | null;
  fetched_at_ms: number;
  frames: Partial<Record<EnvironmentFrame, EnvironmentFrameSummary>>;
}

interface RawBar { t: number; o: number; h: number; l: number; c: number }

function parseBars(rows: unknown, raw: string): RawBar[] {
  if (!Array.isArray(rows)) return [];
  const out: RawBar[] = [];
  for (const r of rows as Array<Record<string, string | number>>) {
    const t = Number(r["t"]);
    const o = Number(r["o"]);
    const h = Number(r["h"]);
    const l = Number(r["l"]);
    const c = Number(r["c"]);
    if (![t, o, h, l, c].every((n) => Number.isFinite(n))) continue;
    if (t <= 0 || c <= 0) continue;
    out.push({ t, o, h, l, c });
  }
  out.sort((a, b) => a.t - b.t);
  void raw;
  return out;
}

function summarize(bars: RawBar[], nowMs: number, frameMs: number): EnvironmentFrameSummary | null {
  // Drop the still-forming bar: its open time is within one frame of now.
  const completed = bars.filter((b) => b.t + frameMs <= nowMs);
  if (!completed.length) return null;
  const last = completed[completed.length - 1]!;
  const prev = completed.length > 1 ? completed[completed.length - 2]! : null;
  const changePct = prev && prev.c > 0 ? ((last.c - prev.c) / prev.c) * 100 : null;
  const range = last.h - last.l;
  return {
    last_closed_ms: last.t + frameMs,
    open: last.o,
    high: last.h,
    low: last.l,
    close: last.c,
    change_pct: changePct == null ? null : Number(changePct.toFixed(4)),
    direction:
      changePct == null ? null : changePct > 0.01 ? "up" : changePct < -0.01 ? "down" : "flat",
    range_position: range > 0 ? Number(((last.c - last.l) / range).toFixed(4)) : null,
    bars: completed.length,
  };
}

const FRAME_MS: Record<EnvironmentFrame, number> = {
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
  "1M": 30 * 86_400_000,
};

const cache = new Map<string, EnvironmentContext>();

/**
 * Fetch native D/W/M bars for one symbol. Never throws.
 *
 * Results are cached per symbol for ENV_FRAME_TTL_MS so a tick evaluating
 * several candidates on the same symbol issues one request per frame at most.
 */
export async function fetchEnvironmentContext(
  displaySymbol: string,
  nowMs: number = Date.now(),
): Promise<EnvironmentContext> {
  const cached = cache.get(displaySymbol);
  if (cached && nowMs - cached.fetched_at_ms < ENV_FRAME_TTL_MS) return cached;

  const raw = displaySymbol.replace("-", "");
  const frames: EnvironmentContext["frames"] = {};
  let anyError: string | null = null;

  await Promise.all(
    (Object.keys(FRAME_TOKENS) as EnvironmentFrame[]).map(async (frame) => {
      try {
        const url = `${APEX_OMNI_HTTP}${KLINES_PATH}?symbol=${raw}&interval=${FRAME_TOKENS[frame]}&limit=60`;
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) {
          anyError = `http_${res.status}`;
          return;
        }
        const body = (await res.json()) as { data?: Record<string, unknown> };
        const summary = summarize(parseBars(body?.data?.[raw], raw), nowMs, FRAME_MS[frame]);
        if (summary) frames[frame] = summary;
        else anyError = anyError ?? "no_completed_bars";
      } catch (e) {
        anyError = e instanceof Error ? `fetch_error:${e.message.slice(0, 60)}` : "fetch_error";
      }
    }),
  );

  const ctx: EnvironmentContext = {
    available: Object.keys(frames).length > 0,
    unavailable_reason: Object.keys(frames).length > 0 ? null : (anyError ?? "no_data"),
    fetched_at_ms: nowMs,
    frames,
  };
  cache.set(displaySymbol, ctx);
  return ctx;
}

/** Test seam — drops the per-symbol TTL cache. */
export function __resetEnvironmentCache(): void {
  cache.clear();
}
