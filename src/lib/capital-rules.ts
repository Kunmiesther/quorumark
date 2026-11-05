/**
 * Global capital rules — apply to every strategy.
 * Displayed in the UI now; enforced by the trading engine later.
 */
export const CAPITAL_RULES = {
  maxTradeCapital: 500,     // USD
  riskPerTradePct: 10,      // %
  tradeSizeMinUsd: 10,
  tradeSizeMaxUsd: 50,
  floorUsd: 100,            // Hard stop floor
  takeProfitPct: 200,       // Take-profit at +200%
  takeProfitResetUsd: 100,  // Reset to $100 ...
  takeProfitCompoundUsd: 300, // ... or compound to $300
} as const;
