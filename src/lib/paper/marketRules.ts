import { compactSymbol } from "./deskMarks";

export type PaperQuantityRules = { stepSize: number; minOrderSize: number };

export function parsePaperQuantityRules(body: unknown, symbol: string): PaperQuantityRules {
  const contracts = (body as { data?: { contractConfig?: { perpetualContract?: unknown } } })
    ?.data?.contractConfig?.perpetualContract;
  const raw = compactSymbol(symbol);
  const row = Array.isArray(contracts) ? contracts.find((item) =>
    compactSymbol(String(item?.symbolDisplayName ?? item?.symbol ?? "")) === raw) : null;
  const stepSize = Number(row?.stepSize);
  const minOrderSize = Number(row?.minOrderSize);
  if (!row || row.enableTrade === false || !Number.isFinite(stepSize) || stepSize <= 0
    || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
    throw new Error("Verified paper market size rules are unavailable. No order was placed.");
  }
  return { stepSize, minOrderSize };
}

/** Public reference metadata only. Never connects to a wallet or submits an order. */
export async function fetchPaperQuantityRules(symbol: string): Promise<PaperQuantityRules> {
  const response = await fetch("https://omni.apex.exchange/api/v3/symbols", {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Paper market size rules could not be loaded. Retry shortly.");
  return parsePaperQuantityRules(await response.json(), symbol);
}
