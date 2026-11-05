import { describe, it, expect } from "vitest";
import {
  buildPerformanceSections,
  type TradeRow,
  type OpenCounts,
} from "@/lib/trade/performanceSections";

const emptyOpen: OpenCounts = {
  bySymbol: new Map(),
  byStrategy: new Map(),
  total: 0,
};

describe("buildPerformanceSections — zero state", () => {
  const sections = buildPerformanceSections({
    trades: [],
    open: emptyOpen,
    bookLabel: "Live book",
  });

  it("returns 5 sections in canonical order", () => {
    expect(sections.map((s) => s.id)).toEqual([
      "overall",
      "by-strategy",
      "by-symbol",
      "streaks",
      "best-worst",
    ]);
  });

  it("renders literal 0 / 0% / $0.00 — never a placeholder glyph", () => {
    const overall = sections[0];
    const byLabel = (l: string) =>
      overall.stats!.find((s) => s.label === l)!.value;
    expect(byLabel("Open")).toBe("0");
    expect(byLabel("Attempted")).toBe("0");
    expect(byLabel("Wins")).toBe("0");
    expect(byLabel("Losses")).toBe("0");
    expect(byLabel("Win rate")).toBe("0%");
    expect(byLabel("Realized")).toBe("$0.00");
    // No ellipsis / tofu glyph leaked in
    for (const s of overall.stats ?? []) {
      expect(s.value).not.toMatch(/[…▨]/);
    }
  });

  it("BY STRATEGY lists all six turtles at 0 with an intentional empty note", () => {
    const strat = sections[1];
    expect(strat.rows?.length).toBe(6);
    expect(strat.rows?.map((r) => r.key).sort()).toEqual(
      ["accumulator", "arbiter", "hunter", "scout", "sweep", "vanguard"].sort(),
    );
    expect(strat.emptyNote).toMatch(/populate/i);
  });

  it("BY SYMBOL falls back to common bases at zero (no fabricated numbers)", () => {
    const bySym = sections[2];
    expect(bySym.rows?.length ?? 0).toBeGreaterThan(0);
    for (const r of bySym.rows ?? []) {
      const trades = r.columns.find((c) => c.label === "Trades")!.value;
      expect(trades).toBe("0");
    }
  });

  it("Streaks + best/worst show em-dash placeholders (never a glyph)", () => {
    const streaks = sections[3];
    const bw = sections[4];
    for (const s of [...(streaks.stats ?? []), ...(bw.stats ?? [])]) {
      expect(s.value).not.toMatch(/[…▨]/);
    }
    expect(streaks.stats!.find((s) => s.label === "Current streak")!.value).toBe(
      "—",
    );
  });

  it("does not divide by zero on win% with no trades", () => {
    // Test that fmtPct(0) → "0%" not "NaN%"
    const overall = sections[0];
    const wr = overall.stats!.find((s) => s.label === "Win rate")!.value;
    expect(wr).not.toMatch(/nan/i);
  });
});

describe("buildPerformanceSections — with real rows", () => {
  const trades: TradeRow[] = [
    { id: "1", symbol: "BTC-USDT", pnl: 100, strategy: "hunter", closed_at: "2026-07-01T00:00:00Z" },
    { id: "2", symbol: "BTC-USDT", pnl: -30, strategy: "hunter", closed_at: "2026-07-02T00:00:00Z" },
    { id: "3", symbol: "ETH-USDT", pnl: 50, strategy: "vanguard", closed_at: "2026-07-03T00:00:00Z" },
    { id: "4", symbol: "ETH-USDT", pnl: 20, strategy: "vanguard", closed_at: "2026-07-04T00:00:00Z" },
    { id: "5", symbol: "SOL-USDT", pnl: -80, strategy: "sniper", closed_at: "2026-07-05T00:00:00Z" },
  ];
  const open: OpenCounts = {
    bySymbol: new Map([["BTC-USDT", 1]]),
    byStrategy: new Map([["hunter", 1]]),
    total: 1,
  };

  const sections = buildPerformanceSections({ trades, open, bookLabel: "Paper book" });

  it("overall computes real wins/losses/pnl", () => {
    const overall = sections[0];
    const by = (l: string) => overall.stats!.find((s) => s.label === l)!.value;
    expect(by("Attempted")).toBe("5");
    expect(by("Wins")).toBe("3");
    expect(by("Losses")).toBe("2");
    expect(by("Win rate")).toBe("60%");
    expect(by("Realized")).toBe("+$60.00");
    expect(by("Open")).toBe("1");
  });

  it("BY STRATEGY normalizes sniper → sweep and ranks by realized", () => {
    const strat = sections[1];
    const keys = strat.rows!.map((r) => r.key);
    // Best realized = vanguard (70) > hunter (70) > … losers below
    expect(keys[keys.length - 1]).toBe("sweep"); // sweep is worst (-80)
    const sweep = strat.rows!.find((r) => r.key === "sweep")!;
    const trades = sweep.columns.find((c) => c.label === "Trades")!.value;
    expect(trades).toBe("1");
  });

  it("BY SYMBOL ranks by realized", () => {
    const bySym = sections[2];
    expect(bySym.rows![0].key).toBe("BTC"); // 70 (tie with ETH; stable)
    expect(bySym.rows![bySym.rows!.length - 1].key).toBe("SOL");
  });

  it("best/worst identify extremes", () => {
    const bw = sections[4];
    const bestPnl = bw.stats!.find((s) => s.label === "Best P&L")!.value;
    const worstPnl = bw.stats!.find((s) => s.label === "Worst P&L")!.value;
    expect(bestPnl).toBe("+$100.00");
    expect(worstPnl).toBe("-$80.00");
  });
});
