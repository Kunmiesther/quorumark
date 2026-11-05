import { describe, it, expect } from "vitest";
import {
  buildLockoutSet,
  isLockedOut,
  lockoutKey,
  REENTRY_LOCKOUT_CANDLES,
  REENTRY_LOCKOUT_MS,
  LOCKOUT_TRIGGER_REASONS,
  type LockoutTradeRow,
} from "../reentryLockout";
import { INTERVAL_MIN } from "../constants";

const CANDLE_MS = INTERVAL_MIN * 60_000;

describe("reentryLockout — constants", () => {
  it("REENTRY_LOCKOUT_CANDLES is 12 (shared parity JSON)", () => {
    expect(REENTRY_LOCKOUT_CANDLES).toBe(12);
  });
  it("window is 12 × 15m = 3 hours", () => {
    expect(REENTRY_LOCKOUT_MS).toBe(12 * 15 * 60_000);
    expect(REENTRY_LOCKOUT_MS).toBe(3 * 60 * 60_000);
  });
  it("trigger reasons cover all Guardian close paths", () => {
    expect([...LOCKOUT_TRIGGER_REASONS].sort()).toEqual(
      ["scout_bos", "scout_guardian_bos", "scout_guardian_cluster"].sort(),
    );
  });
});

describe("reentryLockout — behavior contract", () => {
  const T = 1_000_000_000_000; // arbitrary tick timestamp (ms)

  const closedAt = (candlesAgo: number): number => T - candlesAgo * CANDLE_MS;

  const trade = (
    over: Partial<LockoutTradeRow> & Pick<LockoutTradeRow, "symbol" | "direction">,
  ): LockoutTradeRow => ({
    exit_reason: "scout_bos",
    closed_at_ms: closedAt(0),
    ...over,
  });

  it("blocks same (symbol, direction) 1 candle after a scout_bos close", () => {
    const trades = [trade({ symbol: "LINK-USDT", direction: "long", closed_at_ms: closedAt(1) })];
    const set = buildLockoutSet(trades, T);
    expect(isLockedOut(set, "LINK-USDT", "long")).toBe(true);
  });

  it("does NOT block the opposite direction on the same symbol", () => {
    const trades = [trade({ symbol: "LINK-USDT", direction: "long", closed_at_ms: closedAt(1) })];
    const set = buildLockoutSet(trades, T);
    expect(isLockedOut(set, "LINK-USDT", "short")).toBe(false);
  });

  it("does NOT block a different symbol", () => {
    const trades = [trade({ symbol: "LINK-USDT", direction: "long", closed_at_ms: closedAt(1) })];
    const set = buildLockoutSet(trades, T);
    expect(isLockedOut(set, "BTC-USDT", "long")).toBe(false);
  });

  it("allows re-entry AFTER 12 candles (exactly 12 releases)", () => {
    const trades = [trade({ symbol: "LINK-USDT", direction: "long", closed_at_ms: closedAt(12) })];
    const set = buildLockoutSet(trades, T);
    expect(isLockedOut(set, "LINK-USDT", "long")).toBe(false);
  });

  it("still blocks at 11 candles (strictly within window)", () => {
    const trades = [trade({ symbol: "LINK-USDT", direction: "long", closed_at_ms: closedAt(11) })];
    const set = buildLockoutSet(trades, T);
    expect(isLockedOut(set, "LINK-USDT", "long")).toBe(true);
  });

  it("scout_guardian_bos and scout_guardian_cluster also trigger lockout", () => {
    const trades = [
      trade({ symbol: "BTC-USDT", direction: "long", exit_reason: "scout_guardian_bos", closed_at_ms: closedAt(3) }),
      trade({ symbol: "SOL-USDT", direction: "short", exit_reason: "scout_guardian_cluster", closed_at_ms: closedAt(3) }),
    ];
    const set = buildLockoutSet(trades, T);
    expect(isLockedOut(set, "BTC-USDT", "long")).toBe(true);
    expect(isLockedOut(set, "SOL-USDT", "short")).toBe(true);
  });

  it("non-Guardian exit reasons (tp_touch, stop, floor) never lock out", () => {
    const trades: LockoutTradeRow[] = [
      { symbol: "BTC-USDT", direction: "long", exit_reason: "tp_touch", closed_at_ms: closedAt(1) },
      { symbol: "ETH-USDT", direction: "short", exit_reason: "stop", closed_at_ms: closedAt(1) },
      { symbol: "SOL-USDT", direction: "long", exit_reason: "floor", closed_at_ms: closedAt(1) },
      { symbol: "XRP-USDT", direction: "long", exit_reason: "paper_reset", closed_at_ms: closedAt(1) },
    ];
    const set = buildLockoutSet(trades, T);
    expect(set.size).toBe(0);
  });

  it("ignores malformed rows (bad direction, NaN timestamp)", () => {
    const trades: LockoutTradeRow[] = [
      { symbol: "LINK-USDT", direction: "flat", exit_reason: "scout_bos", closed_at_ms: closedAt(1) },
      { symbol: "BTC-USDT", direction: "long", exit_reason: "scout_bos", closed_at_ms: NaN },
    ];
    const set = buildLockoutSet(trades, T);
    expect(set.size).toBe(0);
  });

  it("lockoutKey format is stable", () => {
    expect(lockoutKey("LINK-USDT", "long")).toBe("LINK-USDT:long");
    expect(lockoutKey("BTC-USDT", "short")).toBe("BTC-USDT:short");
  });
});
