/**
 * OWNER CORRECTION #6 — timeframe completeness.
 *
 * Daily / weekly / monthly context must be REAL venue data, not a permanent
 * "unavailable" placeholder. These frames stay strictly advisory: a failed
 * fetch degrades the block, it never blocks or alters a candidate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchEnvironmentContext, __resetEnvironmentCache, ENV_FRAME_TTL_MS } from "../environmentFrames";

const DAY = 86_400_000;
const NOW = 1_770_000_000_000;

function bar(t: number, o: number, h: number, l: number, c: number) {
  return { t: String(t), o: String(o), h: String(h), l: String(l), c: String(c), v: "1" };
}

function okResponse(rows: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { BTCUSDT: rows } }),
  } as unknown as Response;
}

describe("fetchEnvironmentContext", () => {
  beforeEach(() => __resetEnvironmentCache());
  afterEach(() => vi.restoreAllMocks());

  it("returns real completed 1d/1w/1M summaries from the venue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse([
          bar(NOW - 3 * DAY, 100, 120, 90, 110),
          bar(NOW - 2 * DAY, 110, 130, 105, 125),
          // still-forming bar — must be excluded
          bar(NOW, 125, 126, 124, 125),
        ]),
      ),
    );

    const ctx = await fetchEnvironmentContext("BTC-USDT", NOW);
    expect(ctx.available).toBe(true);
    expect(ctx.unavailable_reason).toBeNull();

    const daily = ctx.frames["1d"]!;
    expect(daily.close).toBe(125);
    expect(daily.direction).toBe("up");
    expect(daily.change_pct).toBeCloseTo(((125 - 110) / 110) * 100, 3);
    // Excluded the forming bar: only the two closed ones counted.
    expect(daily.bars).toBe(2);
    // Close sits at the top of the 105..130 range.
    expect(daily.range_position).toBeCloseTo((125 - 105) / (130 - 105), 3);
    expect(daily.last_closed_ms).toBe(NOW - 2 * DAY + DAY);
  });

  it("marks the block unavailable — never throws — when the venue errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response));
    const ctx = await fetchEnvironmentContext("BTC-USDT", NOW);
    expect(ctx.available).toBe(false);
    expect(ctx.unavailable_reason).toBe("http_503");
    expect(ctx.frames).toEqual({});
  });

  it("never throws when the network itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const ctx = await fetchEnvironmentContext("BTC-USDT", NOW);
    expect(ctx.available).toBe(false);
    expect(ctx.unavailable_reason).toMatch(/fetch_error/);
  });

  it("reports unavailable when only a forming bar exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([bar(NOW, 1, 2, 1, 2)])));
    const ctx = await fetchEnvironmentContext("BTC-USDT", NOW);
    expect(ctx.available).toBe(false);
    expect(ctx.unavailable_reason).toBe("no_completed_bars");
  });

  it("caches per symbol so one tick does not re-request every candidate", async () => {
    const spy = vi.fn(async () => okResponse([bar(NOW - 3 * DAY, 100, 120, 90, 110), bar(NOW - 2 * DAY, 110, 130, 105, 125)]));
    vi.stubGlobal("fetch", spy);

    await fetchEnvironmentContext("BTC-USDT", NOW);
    const calls = spy.mock.calls.length;
    await fetchEnvironmentContext("BTC-USDT", NOW + 1_000);
    expect(spy.mock.calls.length).toBe(calls); // served from cache

    await fetchEnvironmentContext("BTC-USDT", NOW + ENV_FRAME_TTL_MS + 1);
    expect(spy.mock.calls.length).toBeGreaterThan(calls); // TTL expired
  });

  it("requests the venue's native D / W / M intervals, not folded 5m bars", async () => {
    const spy = vi.fn(async () => okResponse([]));
    vi.stubGlobal("fetch", spy);
    await fetchEnvironmentContext("BTC-USDT", NOW);
    const urls = (spy.mock.calls as unknown as unknown[][]).map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("interval=D"))).toBe(true);
    expect(urls.some((u) => u.includes("interval=W"))).toBe(true);
    expect(urls.some((u) => u.includes("interval=M"))).toBe(true);
  });
});
