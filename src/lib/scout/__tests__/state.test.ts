import { describe, it, expect } from "vitest";
import { reduceState, INITIAL_STATE, type StateInput, type CurrentState } from "../state";

function baseInput(overrides: Partial<StateInput> = {}): StateInput {
  return {
    scan_id: "scan-1",
    now: 1_000,
    weighted_score: 0.5,
    htf_valid: true,
    ltf_aligned: true,
    aligned_direction: "long",
    structure_broken: false,
    htf_flipped: false,
    ...overrides,
  };
}

describe("state.reduceState", () => {
  it("WATCHING → BUILDING then ARMED after 2 aligned scans (hysteresis)", () => {
    let cur: CurrentState = INITIAL_STATE;
    let r = reduceState(cur, baseInput({ scan_id: "s1" }));
    expect(r.next.state).toBe("BUILDING");
    expect(r.next.direction).toBe("long");
    expect(r.transition?.to).toBe("BUILDING");
    cur = r.next;
    r = reduceState(cur, baseInput({ scan_id: "s2" }));
    expect(r.next.state).toBe("ARMED");
    expect(r.next.aligned_streak).toBe(2);
  });

  it("ARMED → CONFIRMED on a third aligned scan", () => {
    let cur = INITIAL_STATE;
    cur = reduceState(cur, baseInput({ scan_id: "s1" })).next;
    cur = reduceState(cur, baseInput({ scan_id: "s2" })).next;
    const r = reduceState(cur, baseInput({ scan_id: "s3" }));
    expect(r.next.state).toBe("CONFIRMED");
  });

  it("score-delta jump promotes after a warm-up scan", () => {
    let cur = INITIAL_STATE;
    cur = reduceState(cur, baseInput({ scan_id: "warm", weighted_score: 0.1 })).next;
    expect(cur.state).toBe("BUILDING");
    const r = reduceState(cur, baseInput({ scan_id: "s1", weighted_score: 0.9 }));
    expect(r.next.state).toBe("ARMED");
    expect(r.transition?.reason_codes).toContain("score_delta_jump");
  });

  it("blocks direct long→short flip; must invalidate first", () => {
    let cur = INITIAL_STATE;
    cur = reduceState(cur, baseInput({ scan_id: "s1" })).next; // BUILDING long
    cur = reduceState(cur, baseInput({ scan_id: "s2" })).next; // ARMED long
    const r = reduceState(cur, baseInput({
      scan_id: "s3",
      aligned_direction: "short",
      weighted_score: -0.5,
    }));
    expect(r.next.state).toBe("INVALIDATED");
    expect(r.next.direction).toBe("none");
    expect(r.transition?.reason_codes).toContain("invalidated_flip_blocked");
  });

  it("HTF missing/stale downgrades ARMED to WEAKENING", () => {
    let cur = INITIAL_STATE;
    cur = reduceState(cur, baseInput({ scan_id: "s1" })).next;
    cur = reduceState(cur, baseInput({ scan_id: "s2" })).next; // ARMED
    const r = reduceState(cur, baseInput({ scan_id: "s3", htf_valid: false }));
    expect(r.next.state).toBe("WEAKENING");
    expect(r.transition?.reason_codes).toContain("htf_missing_or_stale");
  });

  it("structure_broken forces INVALIDATED", () => {
    let cur = INITIAL_STATE;
    cur = reduceState(cur, baseInput({ scan_id: "s1" })).next;
    const r = reduceState(cur, baseInput({ scan_id: "s2", structure_broken: true }));
    expect(r.next.state).toBe("INVALIDATED");
    expect(r.next.direction).toBe("none");
  });

  it("is idempotent: replaying same scan_id returns same state, no transition", () => {
    let cur = INITIAL_STATE;
    const first = reduceState(cur, baseInput({ scan_id: "s1" }));
    cur = first.next;
    const replay = reduceState(cur, baseInput({ scan_id: "s1" }));
    expect(replay.next).toEqual(cur);
    expect(replay.transition).toBeNull();
  });

  it("never reaches ARMED without HTF valid", () => {
    let cur = INITIAL_STATE;
    cur = reduceState(cur, baseInput({ scan_id: "s1", htf_valid: false })).next;
    cur = reduceState(cur, baseInput({ scan_id: "s2", htf_valid: false })).next;
    cur = reduceState(cur, baseInput({ scan_id: "s3", htf_valid: false })).next;
    expect(cur.state).toBe("WATCHING");
  });
});
