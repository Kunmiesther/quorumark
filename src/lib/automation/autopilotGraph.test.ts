import { describe, expect, it } from "vitest";
import { approveForPaperValidation, buildAutopilotProposal } from "./autopilotGraph";

const input = {
  name: "Daily conservative plan",
  goalId: "growth",
  goalLabel: "Grow trading balance",
  strategyId: "strategy-1",
  strategyName: "The Guardian",
  authorizedCapital: 100,
  lossLimit: 20,
  targetDays: 30,
  riskMode: "conservative" as const,
  scheduleEnabled: true,
  activeDays: [0, 1, 2, 3, 4, 5, 6],
  windowStart: "00:00",
  windowEnd: "23:59",
  timezone: "America/New_York",
  maxDailyEntries: 1,
  maxOpenPositions: 1,
  connectionId: "connection-1",
  symbols: ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"],
  enabledTurtles: ["accumulator", "vanguard"],
  marginPct: 5 as const,
  rungCount: 5 as const,
  incomeAllocationPct: 100,
};

describe("Autopilot LangGraph workflow", () => {
  it("preserves a reviewed high-frequency limit instead of replacing it with one",async()=>{
    expect(await buildAutopilotProposal({...input,maxDailyEntries:100,maxOpenPositions:6})).toMatchObject({maxDailyEntries:100,maxOpenPositions:6});
  });
  it.each([0,101,1.5,NaN,Infinity])("rejects invalid daily entry limit %s",async maxDailyEntries=>{
    await expect(buildAutopilotProposal({...input,maxDailyEntries})).rejects.toThrow("daily entries");
  });
  it("stops at approval with deterministic limits", async () => {
    const proposal = await buildAutopilotProposal(input);
    expect(proposal.status).toBe("awaiting_approval");
    expect(proposal.maxLossPercent).toBe(20);
    expect(proposal.liveExecutionAllowed).toBe(false);
  });

  it("only advances an approved proposal to paper validation", async () => {
    const proposal = approveForPaperValidation(await buildAutopilotProposal(input));
    expect(proposal.status).toBe("paper_validation");
    expect(proposal.requiresPaperValidation).toBe(true);
    expect(proposal.liveExecutionAllowed).toBe(false);
  });

  it("rejects loss limits above authorized capital", async () => {
    await expect(buildAutopilotProposal({ ...input, lossLimit: 101 })).rejects.toThrow("invalid");
  });

  it("locks dynamic sizing to five percent and five rungs", async () => {
    await expect(buildAutopilotProposal({ ...input, marginPct: 4 as 5 })).rejects.toThrow("5%");
    await expect(buildAutopilotProposal({ ...input, rungCount: 4 as 5 })).rejects.toThrow(
      "five rungs",
    );
  });

  it("routes all positive realized net P&L to the Life Map allocator", async () => {
    await expect(buildAutopilotProposal({ ...input, incomeAllocationPct: 50 })).rejects.toThrow(
      "100%",
    );
  });

  it("preserves a different owned-venue selection for each symbol", async () => {
    const proposal = await buildAutopilotProposal({
      ...input,
      venueAssignments: [
        { symbol: "BTC-USDT", connectionId: "apex-1", walletConnectionId: "wallet-1" },
        { symbol: "ETH-USDT", connectionId: "apex-2", walletConnectionId: "wallet-2" },
        { symbol: "SOL-USDT", connectionId: "venue-3", walletConnectionId: null },
        { symbol: "XRP-USDT", connectionId: "venue-3", walletConnectionId: null },
      ],
    });
    expect(proposal.venueAssignments?.[1]).toEqual({
      symbol: "ETH-USDT",
      connectionId: "apex-2",
      walletConnectionId: "wallet-2",
    });
  });

  it("builds a live configuration without silently enabling execution", async () => {
    const proposal = await buildAutopilotProposal({ ...input, setupBook: "live", leverage: 25 });
    expect(proposal.leverage).toBe(25);
    expect(proposal.setupBook).toBe("live");
    expect(proposal.requiresPaperValidation).toBe(false);
    expect(proposal.liveExecutionAllowed).toBe(false);
    expect(proposal.status).toBe("awaiting_approval");
  });

  it("rejects missing or duplicate symbol-to-venue assignments", async () => {
    await expect(
      buildAutopilotProposal({
        ...input,
        venueAssignments: [
          { symbol: "BTC-USDT", connectionId: "venue-1", walletConnectionId: null },
        ],
      }),
    ).rejects.toThrow("Assign each selected symbol");
  });
  it.each([undefined, 0, -1, 125.5, 126, NaN, Infinity])(
    "rejects unusable live leverage %s",
    async (leverage) => {
      await expect(
        buildAutopilotProposal({ ...input, setupBook: "live", leverage }),
      ).rejects.toThrow("leverage");
    },
  );
});
