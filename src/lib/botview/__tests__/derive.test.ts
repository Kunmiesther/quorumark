import { describe, it, expect } from "vitest";
import { deriveEquitySeries, deriveTargetLines } from "../derive";

describe("deriveEquitySeries", () => {
  it("returns empty for no trades", () => {
    expect(deriveEquitySeries([], 3600)).toEqual([]);
  });

  it("cumulates PnL and starts at baseEquity", () => {
    const s = deriveEquitySeries(
      [
        { closed_at: "2026-01-01T00:00:00Z", pnl_net: 10 },
        { closed_at: "2026-01-01T01:00:00Z", pnl_net: -3 },
        { closed_at: "2026-01-01T02:00:00Z", pnl_net: 5 },
      ],
      3600,
    );
    expect(s[0].equity).toBe(3600);
    expect(s[s.length - 1].equity).toBe(3612);
  });

  it("goes DOWN on losses — no clamp", () => {
    const s = deriveEquitySeries(
      [
        { closed_at: "2026-01-01T00:00:00Z", pnl_net: -1000 },
        { closed_at: "2026-01-01T01:00:00Z", pnl_net: -2000 },
      ],
      100,
    );
    const equities = s.map((p) => p.equity);
    expect(equities).toEqual([100, -900, -2900]);
  });

  it("downsamples to <= maxPoints and keeps the last point", () => {
    const trades = Array.from({ length: 5000 }, (_, i) => ({
      closed_at: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
      pnl_net: 1,
    }));
    const s = deriveEquitySeries(trades, 0, 300);
    expect(s.length).toBeLessThanOrEqual(301);
    expect(s[s.length - 1].equity).toBe(5000);
  });
});

describe("deriveTargetLines", () => {
  it("open non-promoted: TP + STOP + unfilled RUNGs", () => {
    const lines = deriveTargetLines({
      direction: "long",
      tp_level: 110,
      stop_level: 95,
      pending_rungs: [{ price: 99 }, { price: 97 }],
    });
    const labels = lines.map((l) => l.label);
    expect(labels).toEqual(["TP", "STOP", "RUNG 2", "RUNG 3"]);
  });

  it("promoted runner: HIDES TP, hides unfilled rungs, shows BE STOP + 1H STRUCTURE", () => {
    const lines = deriveTargetLines({
      direction: "long",
      tp_level: 110,
      stop_level: 95,
      pending_rungs: [{ price: 97 }],
      promoted: true,
      runner_breakeven_stop: 100.4,
      htf_structure_level: 108,
    });
    const labels = lines.map((l) => l.label);
    expect(labels).not.toContain("TP");
    expect(labels).not.toContain("STOP");
    expect(labels).not.toContain("RUNG 2");
    expect(labels).toContain("BE STOP");
    expect(labels).toContain("1H STRUCTURE");
  });

  it("skips zero/null prices", () => {
    const lines = deriveTargetLines({
      direction: "short",
      tp_level: 0,
      stop_level: null,
      pending_rungs: [{ price: "0" }],
    });
    expect(lines).toEqual([]);
  });
});
