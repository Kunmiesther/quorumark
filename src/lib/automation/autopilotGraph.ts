export type RiskMode = "conservative" | "moderate" | "aggressive";
export type WorkflowStatus = "draft" | "awaiting_approval" | "paper_validation";

export type VenueAssignment = {
  symbol: string;
  connectionId: string;
  walletConnectionId: string | null;
};

export interface AutopilotInput {
  setupBook?: "paper" | "live";
  name: string;
  goalId: string;
  goalLabel: string;
  strategyId: string;
  strategyName: string;
  authorizedCapital: number;
  lossLimit: number;
  targetDays: number;
  riskMode: RiskMode;
  scheduleEnabled: boolean;
  activeDays: number[];
  windowStart: string;
  windowEnd: string;
  timezone: string;
  maxDailyEntries: number;
  maxOpenPositions: number;
  connectionId: string;
  venueAssignments?: VenueAssignment[];
  symbols: string[];
  enabledTurtles: string[];
  marginPct: 5;
  rungCount: 5;
  incomeAllocationPct: number;
  /** Explicit owner choice. Required for live setup; never inferred from risk mode. */
  leverage?: number;
}

export interface AutopilotProposal extends AutopilotInput {
  status: WorkflowStatus;
  maxLossPercent: number;
  requiresPaperValidation: boolean;
  liveExecutionAllowed: false;
}

export async function buildAutopilotProposal(input: AutopilotInput): Promise<AutopilotProposal> {
  if (
    (input.setupBook === "live" || input.leverage !== undefined) &&
    (!Number.isInteger(input.leverage) || input.leverage! < 1 || input.leverage! > 125)
  ) {
    throw new Error(
      "Choose an explicit whole-number leverage from 1× to 125×; venue limits also apply.",
    );
  }
  if (
    input.authorizedCapital <= 0 ||
    input.lossLimit <= 0 ||
    input.lossLimit > input.authorizedCapital
  ) {
    throw new Error("Loss boundaries are invalid.");
  }
  if (!input.name.trim() || input.name.trim().length > 80) {
    throw new Error("Plan name must be between 1 and 80 characters.");
  }
  if (
    input.activeDays.length === 0 ||
    input.activeDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new Error("Choose at least one valid trading day.");
  }
  if (!Number.isInteger(input.maxDailyEntries) || input.maxDailyEntries < 1 || input.maxDailyEntries > 100 ||
      !Number.isInteger(input.maxOpenPositions) || input.maxOpenPositions < 1 || input.maxOpenPositions > 6) {
    throw new Error("Choose 1–100 daily entries and 1–6 concurrent positions.");
  }
  const allowedSymbols = new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"]);
  const allowedTurtles = new Set(["accumulator", "vanguard", "sniper", "hunter", "arbiter"]);
  if (
    !input.connectionId ||
    input.symbols.length === 0 ||
    input.symbols.some((symbol) => !allowedSymbols.has(symbol))
  ) {
    throw new Error("Choose a verified venue and at least one supported symbol.");
  }
  const assignments =
    input.venueAssignments ??
    input.symbols.map((symbol) => ({
      symbol,
      connectionId: input.connectionId,
      walletConnectionId: null,
    }));
  if (
    assignments.length !== input.symbols.length ||
    new Set(assignments.map((assignment) => assignment.symbol)).size !== input.symbols.length ||
    assignments.some(
      (assignment) =>
        !input.symbols.includes(assignment.symbol) ||
        !assignment.connectionId ||
        (assignment.walletConnectionId !== null && !assignment.walletConnectionId),
    )
  ) {
    throw new Error("Assign each selected symbol to exactly one connected venue and wallet.");
  }
  if (
    input.enabledTurtles.length === 0 ||
    input.enabledTurtles.some((turtle) => !allowedTurtles.has(turtle))
  ) {
    throw new Error("Choose at least one trading Turtle.");
  }
  if (input.marginPct !== 5 || input.rungCount !== 5) {
    throw new Error("TurtleBot mandates require 5% dynamic margin split across five rungs.");
  }
  if (input.incomeAllocationPct !== 100) {
    throw new Error("Autopilot allocates 100% of positive realized net P&L to Life Map goals.");
  }
  return {
    ...input,
    setupBook: input.setupBook ?? "paper",
    venueAssignments: assignments,
    name: input.name.trim(),
    maxLossPercent: Number(((input.lossLimit / input.authorizedCapital) * 100).toFixed(2)),
    status: "awaiting_approval",
    requiresPaperValidation: input.setupBook !== "live",
    liveExecutionAllowed: false,
  };
}

export function approveForPaperValidation(proposal: AutopilotProposal): AutopilotProposal {
  if (proposal.status !== "awaiting_approval")
    throw new Error("This plan is not awaiting approval.");
  return { ...proposal, status: "paper_validation", liveExecutionAllowed: false };
}
