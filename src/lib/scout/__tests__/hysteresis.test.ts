import { describe, expect, it } from "vitest";
import { applyHysteresis, HYSTERESIS_JUMP } from "@/lib/scout/hysteresis";

describe("applyHysteresis", () => {
  it("first observation wins", () => {
    const r = applyHysteresis({ prev: null, proposedBias: "long-priority", proposedScore: 0.5 });
    expect(r.bias).toBe("long-priority");
    expect(r.state.streak).toBe(1);
  });

  it("single opposing scan does NOT flip", () => {
    const prev = { bias: "long-priority" as const, streak: 3, lastScore: 0.5 };
    const r = applyHysteresis({ prev, proposedBias: "short-priority", proposedScore: 0.3 });
    expect(r.bias).toBe("long-priority");
  });

  it("large jump can flip immediately", () => {
    const prev = { bias: "long-priority" as const, streak: 3, lastScore: 0.5 };
    const jump = HYSTERESIS_JUMP + 0.1;
    const r = applyHysteresis({
      prev,
      proposedBias: "short-priority",
      proposedScore: 0.5 - jump - 0.5,
    });
    expect(r.bias).toBe("short-priority");
  });

  it("same bias extends streak", () => {
    const prev = { bias: "long-priority" as const, streak: 2, lastScore: 0.4 };
    const r = applyHysteresis({ prev, proposedBias: "long-priority", proposedScore: 0.6 });
    expect(r.bias).toBe("long-priority");
    expect(r.state.streak).toBe(3);
  });
});
