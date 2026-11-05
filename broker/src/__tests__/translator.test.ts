import { describe, it, expect } from "vitest";
import { translateDirective, pilotAllocation, pilotLeverage } from "../translator";
import PARITY from "../../../shared/mainnet_parity_constants.json";

const PILOT = PARITY.pilot;

describe("broker/translator: pilot sizing", () => {
  it("returns zero allocation at or below the reserve floor", () => {
    expect(pilotAllocation(0)).toBe(0);
    expect(pilotAllocation(PILOT.allocation_reserve_floor_usd)).toBe(0);
    expect(pilotAllocation(PILOT.allocation_reserve_floor_usd + 50)).toBe(50);
  });
  it("caps at the ceiling", () => {
    const big = PILOT.allocation_reserve_floor_usd + PILOT.allocation_ceiling_usd + 9999;
    expect(pilotAllocation(big)).toBe(PILOT.allocation_ceiling_usd);
  });
  it("clamps requested leverage", () => {
    expect(pilotLeverage(1)).toBe(1);
    expect(pilotLeverage(PILOT.max_leverage + 50)).toBe(PILOT.max_leverage);
    expect(pilotLeverage(-3)).toBe(1);
  });
});

describe("broker/translator: translateDirective", () => {
  const base = {
    directive_type: "close_position" as const,
    symbol: "BTC-USDT",
    side: "long" as const,
    connection_id: "00000000-0000-0000-0000-000000000000",
    requested_leverage: 100,
    equity_usd: 1_000,
  };

  it("rejects unknown directive types", () => {
    const r = translateDirective({ ...base, directive_type: "yolo_moon" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_directive");
  });

  it("rejects invalid side", () => {
    const r = translateDirective({ ...base, side: "sideways" as unknown as "long" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_side");
  });

  it("rejects equity at the reserve floor", () => {
    const r = translateDirective({ ...base, equity_usd: PILOT.allocation_reserve_floor_usd });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_pilot_allocation");
  });

  it("clamps leverage to pilot ceiling and notes the clamp", () => {
    // Must request ABOVE the ceiling to exercise the clamp. `base` requests
    // exactly the ratified 100x, which is now legal and correctly produces
    // no clamp note — asserting a note there would only re-encode the old
    // stale 10x ceiling.
    const r = translateDirective({ ...base, requested_leverage: PILOT.max_leverage + 50 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.effective_leverage).toBe(PILOT.max_leverage);
      expect(r.notes.join(" ")).toMatch(/leverage clamped/);
    }
  });

  it("passes a request AT the ceiling through unclamped and unnoted", () => {
    const r = translateDirective(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.effective_leverage).toBe(PILOT.max_leverage);
      expect(r.notes.join(" ")).not.toMatch(/leverage clamped/);
    }
  });


  it("computes notional = allocation × leverage", () => {
    const r = translateDirective({
      ...base,
      requested_leverage: PILOT.max_leverage,
      equity_usd: PILOT.allocation_reserve_floor_usd + 200,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.allocation_usd).toBe(200);
      expect(r.notional_usd).toBe(200 * PILOT.max_leverage);
      expect(r.reduce_only).toBe(true);
      expect(r.emit).toBe(true);
      expect(r.dry_run).toBe(true);
    }
  });

  it("flags reduce-only for cancel_unfilled_rungs without emitting a new order", () => {
    const r = translateDirective({ ...base, directive_type: "cancel_unfilled_rungs" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reduce_only).toBe(true);
      expect(r.emit).toBe(false);
    }
  });
});
