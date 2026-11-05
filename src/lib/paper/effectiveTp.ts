/**
 * EFFECTIVE TP — pure helper for the paper engine's exit loop.
 *
 * FIX 1 (TP mismatch, live-money-critical):
 * The exit loop historically compared only the per-lot rung TP (`lot.tp`,
 * often a flat ±1% DCA rung target). The strategy's real structural / ATR
 * target lives on `paper_positions.tp_level` and is what the UI displays.
 * When those diverged, trades ran past their advertised target.
 *
 * Rule: the EFFECTIVE tp is the target NEAREST to entry in the position's
 * direction — `min` for longs, `max` for shorts — so whichever mechanism
 * defined the tighter exit wins. When `tp_level` is missing/invalid the
 * per-lot rung TP stands alone (backward-compat: legacy sniper/hunter/dca).
 *
 * Live-parity mirror: the Python worker's exit code applies the same rule.
 * See docs/MAINNET_PARITY.md §2.
 */
export type Direction = "long" | "short";

export function effectiveTp(
  direction: Direction,
  lotTp: number,
  positionTpLevel: number | null | undefined,
): number {
  const tpL = Number(positionTpLevel);
  if (!Number.isFinite(tpL) || tpL <= 0) return lotTp;
  return direction === "long" ? Math.min(lotTp, tpL) : Math.max(lotTp, tpL);
}
