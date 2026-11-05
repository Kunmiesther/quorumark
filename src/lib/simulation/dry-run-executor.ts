/**
 * DRY-RUN / SIMULATION order executor.
 *
 * ⚠️ SAFETY:
 *   - This module NEVER calls ApeX (or any venue) order-placement,
 *     order-cancel, leverage, margin, withdrawal, or transfer endpoints.
 *   - It is a pure client-side simulator. Nothing in here can place a real
 *     trade. The app-env execution lock (EXECUTION_ENABLED=false) is not
 *     consulted or altered — even if it were flipped, this file still would
 *     not place a real order because it has no live-order code path.
 *   - The only network call is an OPTIONAL public read of ApeX Omni's
 *     public ticker for a realistic simulated fill price. On any failure
 *     it falls back to a hardcoded reference price.
 *   - Do NOT import a real exchange client here. Do NOT add order/cancel
 *     methods here. If you need a live path, build it in a separate module
 *     behind the execution lock — not in this file.
 */

export type StepKind = "place" | "confirm" | "position" | "close";
export type StepStatus = "pending" | "running" | "done" | "error";

export interface DryRunStep {
  kind: StepKind;
  label: string;
  status: StepStatus;
  detail?: string;
  data?: Record<string, string | number>;
  at?: number;
}

export interface DryRunResult {
  symbol: string;
  side: "long";
  leverage: number;
  notionalUsd: number;
  entryPrice: number;
  exitPrice: number;
  sizeBtc: number;
  feesUsd: number;
  liquidationPrice: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  steps: DryRunStep[];
  simulated: true;
}

const APEX_OMNI_PUBLIC_TICKER =
  "https://omni.apex.exchange/api/v3/ticker?symbol=BTC-USDT";

// Taker fee assumption for a market order round-trip on ApeX Omni.
const TAKER_FEE_RATE = 0.0005; // 5 bps per side

async function fetchBtcMarkPrice(): Promise<{ price: number; source: "apex" | "fallback" }> {
  try {
    const res = await fetch(APEX_OMNI_PUBLIC_TICKER, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    const arr = Array.isArray(body?.data) ? body.data : [];
    const first = arr[0] as { lastPrice?: string; price?: string } | undefined;
    const raw = first?.lastPrice ?? first?.price;
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return { price: n, source: "apex" };
    throw new Error("no price in response");
  } catch {
    return { price: 65_000, source: "fallback" };
  }
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface DryRunOptions {
  notionalUsd?: number;
  leverage?: number;
  onStep?: (steps: DryRunStep[]) => void;
}

/**
 * Run a full simulated BTC-PERP long round-trip: place → confirm →
 * position (with a small simulated price drift) → close.
 * Returns the final trace. Emits progressive updates via onStep.
 */
export async function runDryRunRoundTrip(
  opts: DryRunOptions = {},
): Promise<DryRunResult> {
  const notionalUsd = Math.min(Math.max(opts.notionalUsd ?? 50, 5), 100);
  const leverage = Math.min(Math.max(opts.leverage ?? 2, 1), 3);
  const symbol = "BTC-USDT (PERP, ApeX Omni — SIMULATED)";

  const steps: DryRunStep[] = [
    { kind: "place", label: "Place simulated market order", status: "pending" },
    { kind: "confirm", label: "Simulated fill confirmation", status: "pending" },
    { kind: "position", label: "Track simulated open position", status: "pending" },
    { kind: "close", label: "Close simulated position", status: "pending" },
  ];
  const emit = () => opts.onStep?.(steps.map((s) => ({ ...s })));
  emit();

  // (a) PLACE
  steps[0].status = "running";
  steps[0].at = Date.now();
  steps[0].detail = "No real order is submitted. Building a simulated market order.";
  emit();
  await delay(400);
  const { price: entryPrice, source } = await fetchBtcMarkPrice();
  const sizeBtc = notionalUsd / entryPrice;
  const entryFee = notionalUsd * TAKER_FEE_RATE;
  steps[0].status = "done";
  steps[0].data = {
    symbol,
    side: "long",
    leverage: `${leverage}x`,
    notional: fmtUsd(notionalUsd),
    priceSource: source === "apex" ? "ApeX Omni public ticker" : "fallback (offline)",
  };
  emit();

  // (b) CONFIRM
  steps[1].status = "running";
  steps[1].at = Date.now();
  emit();
  await delay(500);
  // Simple isolated-margin liquidation approximation for a long:
  //   liq ≈ entry * (1 - 1/leverage + fees_buffer)
  const liquidationPrice = entryPrice * (1 - 1 / leverage + TAKER_FEE_RATE * 2);
  steps[1].status = "done";
  steps[1].detail = "Fill simulated. No funds moved.";
  steps[1].data = {
    entryPrice: fmtUsd(entryPrice),
    size: `${sizeBtc.toFixed(6)} BTC`,
    notional: fmtUsd(notionalUsd),
    leverage: `${leverage}x`,
    estFee: fmtUsd(entryFee),
    estLiquidation: fmtUsd(liquidationPrice),
  };
  emit();

  // (c) POSITION — simulate a short price drift while "holding"
  steps[2].status = "running";
  steps[2].at = Date.now();
  emit();
  const drift = (Math.random() * 0.008 - 0.002); // -0.2% .. +0.6%
  const holdingSteps = 4;
  let midPrice = entryPrice;
  for (let i = 1; i <= holdingSteps; i++) {
    await delay(400);
    midPrice = entryPrice * (1 + (drift * i) / holdingSteps);
    const upnl = (midPrice - entryPrice) * sizeBtc;
    const upnlPct = ((midPrice - entryPrice) / entryPrice) * leverage * 100;
    steps[2].data = {
      markPrice: fmtUsd(midPrice),
      unrealizedPnl: `${upnl >= 0 ? "+" : ""}${fmtUsd(upnl)}`,
      unrealizedPct: `${upnlPct >= 0 ? "+" : ""}${upnlPct.toFixed(2)}%`,
      age: `${i * 400}ms`,
    };
    emit();
  }
  steps[2].status = "done";
  emit();

  // (d) CLOSE
  steps[3].status = "running";
  steps[3].at = Date.now();
  emit();
  await delay(500);
  const exitPrice = midPrice;
  const exitFee = (exitPrice * sizeBtc) * TAKER_FEE_RATE;
  const feesUsd = entryFee + exitFee;
  const gross = (exitPrice - entryPrice) * sizeBtc;
  const realizedPnlUsd = gross - feesUsd;
  const realizedPnlPct = (realizedPnlUsd / notionalUsd) * 100;
  steps[3].status = "done";
  steps[3].detail = "Simulated close. No real position ever existed on ApeX.";
  steps[3].data = {
    exitPrice: fmtUsd(exitPrice),
    grossPnl: `${gross >= 0 ? "+" : ""}${fmtUsd(gross)}`,
    fees: fmtUsd(feesUsd),
    realizedPnl: `${realizedPnlUsd >= 0 ? "+" : ""}${fmtUsd(realizedPnlUsd)}`,
    realizedPct: `${realizedPnlPct >= 0 ? "+" : ""}${realizedPnlPct.toFixed(2)}%`,
  };
  emit();

  return {
    symbol,
    side: "long",
    leverage,
    notionalUsd,
    entryPrice,
    exitPrice,
    sizeBtc,
    feesUsd,
    liquidationPrice,
    realizedPnlUsd,
    realizedPnlPct,
    steps,
    simulated: true,
  };
}
