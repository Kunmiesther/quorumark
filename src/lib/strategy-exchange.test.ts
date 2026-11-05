import { describe, expect, it } from "vitest";
import { evaluateSignal, executePaper, recomputePerformance, runReferenceBacktest, seedStrategies } from "./strategy-exchange";

describe("strategy exchange safety boundary", () => {
  const signal = seedStrategies[0].signals[0];
  it("rejects a signal above the follower trade limit", () => {
    const decision = evaluateSignal(signal, { capital: 10_000, maxTrade: 500, maxPosition: 2_500, maxSlippage: 30, approvedAssets: ["BTC"], paused: false }, "follower-a");
    expect(decision.status).toBe("rejected");
    expect(decision.reason).toMatch(/trade limit/);
  });
  it("allows the same signal for a follower with a larger independent limit", () => {
    const decision = evaluateSignal(signal, { capital: 10_000, maxTrade: 2_000, maxPosition: 2_500, maxSlippage: 30, approvedAssets: ["BTC"], paused: false }, "follower-b");
    expect(decision.status).toBe("accepted");
    expect(executePaper(decision, signal, "follower-b")?.environment).toBe("paper");
  });
  it("recomputes net performance with fees separated", () => {
    const decision = evaluateSignal(signal, { capital: 10_000, maxTrade: 2_000, maxPosition: 2_500, maxSlippage: 30, approvedAssets: ["BTC"], paused: false }, "follower-b");
    const execution = executePaper(decision, signal, "follower-b");
    const metrics = recomputePerformance(execution ? [execution] : [], 10_000);
    expect(metrics.trades).toBe(1);
    expect(metrics.costs).toBeGreaterThan(0);
    expect(metrics.returnPct).toBeLessThan(execution!.pnl / 100);
  });
  it("produces deterministic backtest output", () => {
    expect(runReferenceBacktest()).toEqual(runReferenceBacktest());
  });
});
