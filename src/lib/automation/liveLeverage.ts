/** Application adapter ceilings, not a promise of a venue's symbol limit. */
export function liveLeverageMaximum(venue: string | undefined): number {
  return venue === "aster" ? 125 : venue === "apex_omni" ? 100 : 0;
}

export function validLiveLeverage(value: number, venue: string | undefined): boolean {
  return Number.isInteger(value) && value >= 1 && value <= liveLeverageMaximum(venue);
}
