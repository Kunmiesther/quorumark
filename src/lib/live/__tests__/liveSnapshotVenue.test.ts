import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLiveSnapshot, type LivePositionFacts } from "../liveSnapshot.server";
import { publicCouncilCandles } from "@/lib/ai/publicCouncilCandles.server";
import { fetchEnvironmentContext } from "@/lib/paper/environmentFrames";
import type { Candle } from "@/lib/paper/signal";
vi.mock("@/lib/ai/publicCouncilCandles.server", () => ({ publicCouncilCandles: vi.fn() }));
vi.mock("@/lib/paper/environmentFrames", () => ({ fetchEnvironmentContext: vi.fn() }));
const now = 1_800_000_000_000;
const facts: LivePositionFacts = {
  position_id: "p",
  exchange: "aster",
  symbol: "BTC-USDT",
  direction: "long",
  size: 1,
  entry_price: 100,
  mark_price: 101,
  leverage: 1,
  liquidation_price: null,
  unrealized_pnl: 1,
  unrealized_pnl_pct: 1,
  opened_at: "2026-01-01",
  open_order_count: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(publicCouncilCandles).mockImplementation(async (venue, _symbol, interval = 5) => {
    if (!["aster", "apex_omni"].includes(venue)) throw new Error("unknown venue");
    const frame = interval * 60_000;
    return Array.from(
      { length: 80 },
      (_, index) =>
        [Math.floor(now / frame) * frame - (80 - index) * frame, 100, 102, 99, 101, 10] as Candle,
    );
  });
  vi.mocked(fetchEnvironmentContext).mockResolvedValue({
    available: false,
    frames: {},
    fetched_at_ms: now,
    unavailable_reason: "test",
  });
});
describe("live position venue evidence", () => {
  it("uses Aster for every intraday frame without ApeX environment substitution", async () => {
    const snapshot = await buildLiveSnapshot(facts, now);
    expect(vi.mocked(publicCouncilCandles).mock.calls.map((call) => call[0])).toEqual([
      "aster",
      "aster",
      "aster",
    ]);
    expect(fetchEnvironmentContext).not.toHaveBeenCalled();
    expect(snapshot.position.exchange).toBe("aster");
    expect(snapshot.environment_available).toBe(false);
    expect(snapshot.timeframe_source["1h"]).toBe("native");
  });
  it("does not reuse Aster BTC higher-timeframe caches for ApeX BTC", async () => {
    await buildLiveSnapshot(facts, now);
    vi.mocked(publicCouncilCandles).mockClear();
    await buildLiveSnapshot({ ...facts, exchange: "apex_omni" }, now);
    expect(vi.mocked(publicCouncilCandles).mock.calls.map((call) => call[0])).toEqual([
      "apex_omni",
      "apex_omni",
      "apex_omni",
    ]);
    expect(fetchEnvironmentContext).toHaveBeenCalledWith("BTC-USDT", now);
  });
  it("fails an unknown route instead of silently using ApeX", async () => {
    await expect(buildLiveSnapshot({ ...facts, exchange: "" }, now)).rejects.toThrow(
      "unknown venue",
    );
  });
});
