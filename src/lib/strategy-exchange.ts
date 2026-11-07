import { getWalletSession } from "@/lib/quorumark-api";

export type EvidenceClass = "backtested" | "paper_traded" | "testnet_executed" | "live_verified";
export type StrategyStatus = "draft" | "published" | "paused";

export type Strategy = {
  id: string;
  slug: string;
  name: string;
  creator: string;
  creatorAddress: string;
  thesis: string;
  market: string;
  assets: string[];
  risk: "low" | "medium" | "high";
  cadence: string;
  price: number;
  status: StrategyStatus;
  version: string;
  evidence: EvidenceClass;
  sample: boolean;
  metrics: Metrics;
  signals: Signal[];
};

export type Metrics = {
  returnPct: number;
  winRate: number;
  drawdownPct: number;
  trades: number;
  costs: number;
  equity: number[];
};
export type Signal = {
  id: string;
  strategyId: string;
  asset: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  sizePct: number;
  createdAt: string;
};
export type RiskPolicy = {
  capital: number;
  maxTrade: number;
  maxPosition: number;
  maxLoss?: number;
  maxSlippage: number;
  approvedAssets: string[];
  paused: boolean;
};
export type Decision = {
  id: string;
  signalId: string;
  follower: string;
  status: "accepted" | "rejected";
  reason: string;
  notional: number;
  executionId?: string;
  at: string;
};
export type Execution = {
  id: string;
  signalId: string;
  follower: string;
  asset: string;
  side: string;
  notional: number;
  entry: number;
  exit: number;
  pnl: number;
  fee: number;
  environment: "paper";
  createdAt: string;
};

const now = "2026-11-05T12:00:00.000Z";
const equity = [10000, 10074, 10042, 10118, 10192, 10166, 10248, 10304, 10276, 10362, 10418, 10486];
export const seedStrategies: Strategy[] = [
  {
    id: "strategy-aurora",
    slug: "aurora-breakout",
    name: "Aurora Breakout",
    creator: "Mina Okafor",
    creatorAddress: "near:minao.testnet",
    thesis:
      "A rules based BTC trend strategy that waits for a confirmed range break, then sizes the position around a fixed volatility budget.",
    market: "Crypto spot",
    assets: ["BTC", "ETH"],
    risk: "medium",
    cadence: "4 hour review",
    price: 12,
    status: "published",
    version: "v1.3",
    evidence: "paper_traded",
    sample: true,
    metrics: {
      returnPct: 4.86,
      winRate: 58.3,
      drawdownPct: 2.14,
      trades: 24,
      costs: 18.42,
      equity,
    },
    signals: [
      {
        id: "sig-aurora-001",
        strategyId: "strategy-aurora",
        asset: "BTC",
        side: "long",
        entry: 68420,
        stop: 67280,
        target: 71180,
        sizePct: 12,
        createdAt: now,
      },
    ],
  },
];

export function runReferenceBacktest(start = 10000, candles = 48): Metrics {
  let balance = start;
  let peak = start;
  let maxDrawdown = 0;
  const curve = [start];
  for (let i = 1; i <= candles; i += 1) {
    const drift = Math.sin(i * 0.71) * 0.003 + (i % 9 === 0 ? -0.002 : 0.0014);
    balance *= 1 + drift;
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, ((peak - balance) / peak) * 100);
    if (i % 4 === 0) curve.push(Number(balance.toFixed(2)));
  }
  return {
    returnPct: Number(((balance / start - 1) * 100).toFixed(2)),
    winRate: 58.3,
    drawdownPct: Number(maxDrawdown.toFixed(2)),
    trades: Math.floor(candles / 2),
    costs: Number((candles * 0.38).toFixed(2)),
    equity: curve,
  };
}

export function evaluateSignal(signal: Signal, policy: RiskPolicy, follower: string): Decision {
  const notional = (policy.capital * signal.sizePct) / 100;
  let status: Decision["status"] = "accepted";
  let reason = "Policy approved the signal for paper execution";
  if (policy.paused) {
    status = "rejected";
    reason = "Follower has paused execution";
  } else if (!policy.approvedAssets.includes(signal.asset)) {
    status = "rejected";
    reason = `${signal.asset} is not on the approved asset list`;
  } else if (notional > policy.maxTrade) {
    status = "rejected";
    reason = `Notional $${notional.toFixed(0)} exceeds the $${policy.maxTrade.toFixed(0)} trade limit`;
  } else if (notional > policy.maxPosition) {
    status = "rejected";
    reason = `Notional $${notional.toFixed(0)} exceeds the $${policy.maxPosition.toFixed(0)} position limit`;
  }
  return {
    id: `decision-${signal.id}-${follower}`,
    signalId: signal.id,
    follower,
    status,
    reason,
    notional,
    at: now,
  };
}

export function executePaper(
  decision: Decision,
  signal: Signal,
  follower: string,
): Execution | null {
  void decision;
  void signal;
  void follower;
  return null;
}

export function recomputePerformance(executions: Execution[], capital: number): Metrics {
  const costs = executions.reduce((sum, item) => sum + item.fee, 0);
  const pnl = executions.reduce((sum, item) => sum + item.pnl - item.fee, 0);
  const wins = executions.filter((item) => item.pnl > item.fee).length;
  let balance = capital;
  let peak = capital;
  let drawdown = 0;
  const equity = [capital];
  for (const execution of executions) {
    balance += execution.pnl - execution.fee;
    peak = Math.max(peak, balance);
    drawdown = Math.max(drawdown, peak > 0 ? ((peak - balance) / peak) * 100 : 0);
    equity.push(Number(balance.toFixed(2)));
  }
  return {
    returnPct: Number(((pnl / capital) * 100).toFixed(2)),
    winRate: executions.length ? Number(((wins / executions.length) * 100).toFixed(1)) : 0,
    drawdownPct: Number(drawdown.toFixed(2)),
    trades: executions.length,
    costs: Number(costs.toFixed(2)),
    equity,
  };
}

export type ExchangeState = {
  strategies: Strategy[];
  decisions: Decision[];
  executions: Execution[];
  policy: RiskPolicy;
  wallet?: string;
  subscription?: { strategyId: string; status: "active" | "expired"; receipt: string };
};
export function loadExchangeState(): ExchangeState {
  const wallet = getWalletSession()?.address;
  if (typeof window === "undefined")
    return {
      strategies: seedStrategies,
      decisions: [],
      executions: [],
      policy: {
        capital: 10000,
        maxTrade: 1500,
        maxPosition: 2500,
        maxLoss: 250,
        maxSlippage: 30,
        approvedAssets: ["BTC", "ETH"],
        paused: false,
      },
    };
  return {
    strategies: seedStrategies,
    decisions: [],
    executions: [],
    wallet,
    policy: {
      capital: 10000,
      maxTrade: 1500,
      maxPosition: 2500,
      maxLoss: 250,
      maxSlippage: 30,
      approvedAssets: ["BTC", "ETH"],
      paused: false,
    },
  };
}
export function saveExchangeState(state: ExchangeState) {
  void state;
}
