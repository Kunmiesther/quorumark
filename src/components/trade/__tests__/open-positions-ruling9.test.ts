/**
 * Ruling #9 — Open Positions panel guards.
 *
 * These tests pin the display contract the owner ruled on:
 *   (a) a null stop_level renders "None" and never a guarded label,
 *   (b) sub-dollar prices render with at least 5 decimals,
 *   (c) a stale / absent mark renders an em-dash — never $0.00.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatPrice, formatSize } from "@/lib/formatPrice";

const DESK_SRC = fs.readFileSync(path.resolve(__dirname, "../TradeDesk.tsx"), "utf8");

describe("formatPrice — magnitude-aware precision (DEFECT 2)", () => {
  it("renders sub-dollar assets with at least 5 decimals", () => {
    expect(formatPrice(0.1546)).toBe("0.15460");
    expect(formatPrice(0.0698)).toBe("0.06980");
    // Owner-cited defect: fixed 2-decimal rendering would give "0.16" / "0.07".
    expect(formatPrice(0.1546)).not.toBe("0.16");
    expect(formatPrice(0.0698)).not.toBe("0.07");
  });

  it("uses thousands separators and 2 decimals for prices >= 1000", () => {
    expect(formatPrice(63453.6)).toBe("63,453.60");
  });

  it("uses 4 decimals for prices between 1 and 1000", () => {
    expect(formatPrice(1.884)).toBe("1.8840");
  });

  it("renders em-dash for null / non-finite input, never $0.00", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(undefined)).toBe("—");
    expect(formatPrice(Number.NaN)).toBe("—");
  });
});

describe("formatSize — magnitude-aware", () => {
  it("keeps meaningful precision for small sizes", () => {
    expect(formatSize(1.769)).toBe("1.769");
    expect(formatSize(0.01182)).toBe("0.01182");
  });

  it("uses thousands separators for large sizes", () => {
    expect(formatSize(9670.33)).toBe("9,670.33");
  });
});

describe("OpenPositionsCard source — Ruling #9 contract", () => {
  it("keeps an unavailable recorded wallet distinct from no assignment", () => {
    expect(DESK_SRC).toMatch(/r\.wallet_connection_id\s*\? "Recorded wallet is unavailable"/);
  });

  it("uses a named fallback for external positions with an empty exchange", () => {
    expect(DESK_SRC).toContain('venueLabel(r.exchange || "Venue")');
  });

  it("DEFECT 1 — never renders a static 'Guarded' badge", () => {
    // The literal green safety label was hardcoded on every row. If it
    // reappears the false-safety indicator is back.
    expect(DESK_SRC).not.toMatch(/>Guarded</);
  });

  it("DEFECT 1 — renders explicit 'None' when stop is absent", () => {
    expect(DESK_SRC).toMatch(/data-testid="stop-none"/);
    expect(DESK_SRC).toMatch(/>\s*None\s*</);
  });

  it("DEFECT 1 — renders the actual stop price when armed", () => {
    expect(DESK_SRC).toMatch(/data-testid="stop-present"/);
    expect(DESK_SRC).toMatch(/formatPrice\(r\.stop\)/);
  });

  it("DEFECT 3 — em-dash for unavailable PnL, never $0.00 green", () => {
    expect(DESK_SRC).toMatch(/data-testid="pnl-unavailable"/);
    // Panel-level staleness notice must be surfaced, not hidden.
    expect(DESK_SRC).toMatch(/open-positions-stale-notice-/);
    // The old, broken fallback that let mark default to entry must be gone.
    expect(DESK_SRC).not.toMatch(/mark_price \?\? r\.current_price \?\? entry/);
  });

  it("DEFECT 2 — panel uses magnitude-aware formatters, not fixed fmt()", () => {
    expect(DESK_SRC).toMatch(/formatPrice\(r\.entry\)/);
    expect(DESK_SRC).toMatch(/formatSize\(r\.size\)/);
  });

  it("Layout — position identity, exposure, and protection stay visible", () => {
    expect(DESK_SRC).toMatch(/>Symbol</);
    expect(DESK_SRC).toMatch(/>Exchange</);
    expect(DESK_SRC).toMatch(/>Wallet</);
    expect(DESK_SRC).toMatch(/>Size</);
    expect(DESK_SRC).toMatch(/>Entry \/ Mark</);
    expect(DESK_SRC).toMatch(/>Margin</);
    expect(DESK_SRC).toMatch(/>Leverage</);
    expect(DESK_SRC).toMatch(/>PnL</);
    expect(DESK_SRC).toMatch(/>Stop</);
  });
});
