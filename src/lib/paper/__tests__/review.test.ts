import { describe, it, expect } from "vitest";
import { classifyOutcome, rMultiple, scoreOpinion } from "../review.server";

describe("review agent — outcome attribution", () => {
  it("classifies realized outcomes", () => {
    expect(classifyOutcome(5)).toBe("win");
    expect(classifyOutcome(-5)).toBe("loss");
    expect(classifyOutcome(0)).toBe("scratch");
  });

  it("scores a seat against the side that actually made money", () => {
    expect(scoreOpinion("long", "long", "win")).toBe(true);
    expect(scoreOpinion("long", "long", "loss")).toBe(false);
    expect(scoreOpinion("short", "long", "loss")).toBe(true);
    expect(scoreOpinion("wait", "long", "loss")).toBe(true);
    expect(scoreOpinion("wait", "long", "win")).toBe(false);
  });

  it("never scores a seat that did not answer, and never scores a scratch", () => {
    expect(scoreOpinion(null, "long", "win")).toBeNull();
    expect(scoreOpinion("long", "long", "scratch")).toBeNull();
  });

  it("computes R multiples only when stop geometry exists", () => {
    expect(rMultiple(20, 100, 90, 1)).toBe(2);
    expect(rMultiple(-10, 100, 90, 1)).toBe(-1);
    expect(rMultiple(20, 100, null, 1)).toBeNull();
    expect(rMultiple(20, 100, 100, 1)).toBeNull();
  });
});
