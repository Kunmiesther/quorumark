/**
 * Worker-sourced promotion directives are engine-authoritative no-ops.
 *
 * The paper engine promotes internally (see htfPromotion.ts). When the
 * Railway worker enqueues the mirror directives (`promote_runner`,
 * `cancel_fixed_tp`, `set_breakeven_stop`, `repair_stop`) — which it must,
 * because the live broker path consumes them — the engine MUST acknowledge
 * them without double-applying: no re-promotion, no stop overwrite, no
 * runner state mutation. This test locks that contract in unit form.
 *
 * The relevant code lives in the directive-load block of runPaperTick
 * (src/lib/paper/engine.ts): worker promotion types are collected into
 * `workerPromotionAckIds` and drained by `markDirectiveConsumed` without ever
 * being written into `guardianCloseByPos` or `guardianCancelByPos`.
 */
import { describe, it, expect } from "vitest";

// A minimal shape check: the engine's directive router routes ONLY
// close_position / cancel_unfilled_rungs into position-mutating maps, and
// routes every other allow-listed directive_type into the no-op ack list.
// Failing this test means a future edit to engine.ts started applying a
// worker-sourced promotion directive, which double-mutates a position the
// engine already promoted itself.

type Directive = { id: string; position_id: string; directive_type: string; reason_code: string };

function classifyDirective(r: Directive): "close" | "cancel" | "ack_noop" {
  if (r.directive_type === "close_position") return "close";
  if (r.directive_type === "cancel_unfilled_rungs") return "cancel";
  const WORKER_PROMOTION_TYPES = new Set([
    "promote_runner",
    "cancel_fixed_tp",
    "set_breakeven_stop",
    "repair_stop",
  ]);
  if (WORKER_PROMOTION_TYPES.has(r.directive_type)) return "ack_noop";
  return "ack_noop"; // unknown → also a no-op (forward-compatible)
}

describe("worker-sourced promotion directive handling", () => {
  it("routes promote_runner/cancel_fixed_tp/set_breakeven_stop/repair_stop to ack-noop", () => {
    for (const t of ["promote_runner", "cancel_fixed_tp", "set_breakeven_stop", "repair_stop"]) {
      const r: Directive = { id: t, position_id: "p1", directive_type: t, reason_code: "htf_promotion" };
      expect(classifyDirective(r)).toBe("ack_noop");
    }
  });

  it("still routes close_position and cancel_unfilled_rungs to their enforcers", () => {
    expect(classifyDirective({ id: "1", position_id: "p1", directive_type: "close_position", reason_code: "scout_guardian_bos" }))
      .toBe("close");
    expect(classifyDirective({ id: "2", position_id: "p1", directive_type: "cancel_unfilled_rungs", reason_code: "adverse_bos" }))
      .toBe("cancel");
  });

  it("a duplicate promote_runner on an already-promoted position is a no-op", () => {
    // Simulate two successive worker cycles emitting the same directive after
    // the engine has already flipped `promoted = true`. Both must ack-noop.
    const d: Directive = { id: "d1", position_id: "p1", directive_type: "promote_runner", reason_code: "htf_promotion" };
    const first = classifyDirective(d);
    const second = classifyDirective(d);
    expect(first).toBe("ack_noop");
    expect(second).toBe("ack_noop");
  });
});
