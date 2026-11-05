/**
 * Life Map — surplus reallocation pure function.
 *
 * `allocate()` fills bills in priority order and stops giving a bill more
 * once it hits its cap — but it can never take money that's ALREADY sitting
 * on an over-cap bill and move it elsewhere. That happens when a bill's
 * `amount_usd` is lowered, or it's paid off some other way, after
 * allocations already landed on it: the excess sits there, invisible
 * (getLifeMapSnapshot clamps it out of the totals), never offered to any
 * other bill. This function finds that excess and matches it to the
 * smallest uncovered gaps first, so a modest surplus fully closes a couple
 * of small bills rather than making a dent in one large one.
 *
 * Determinism: no I/O, no clocks, no mutation. Same inputs, same outputs.
 */

export interface BillCoverage {
  id: string;
  amount_usd: number;
  covered_usd: number;
}

export interface ReallocationTarget {
  bill_id: string;
  amount_usd: number;
}

export interface ReallocationSuggestion {
  source_bill_id: string;
  surplus_usd: number;
  targets: ReallocationTarget[];
}

const CENTS = 100;
function toCents(usd: number): number {
  return Math.round(usd * CENTS);
}
function fromCents(c: number): number {
  const v = c / CENTS;
  return v === 0 ? 0 : v;
}

/**
 * One suggestion per over-cap source bill. Targets are every OTHER
 * under-cap bill, smallest gap first, filled only as far as the source's
 * own surplus stretches. A bill already at or over its own cap is never a
 * target. Bills with zero surplus produce no suggestion.
 */
export function suggestReallocations(bills: readonly BillCoverage[]): ReallocationSuggestion[] {
  const suggestions: ReallocationSuggestion[] = [];

  for (const source of bills) {
    const surplusCents = toCents(source.covered_usd) - toCents(source.amount_usd);
    if (surplusCents <= 0) continue;

    const gaps = bills
      .filter((b) => b.id !== source.id)
      .map((b) => ({ id: b.id, gapCents: toCents(b.amount_usd) - toCents(b.covered_usd) }))
      .filter((b) => b.gapCents > 0)
      .sort((a, b) => a.gapCents - b.gapCents || (a.id < b.id ? -1 : 1));

    let remaining = surplusCents;
    const targets: ReallocationTarget[] = [];
    for (const g of gaps) {
      if (remaining <= 0) break;
      const take = Math.min(g.gapCents, remaining);
      targets.push({ bill_id: g.id, amount_usd: fromCents(take) });
      remaining -= take;
    }

    if (targets.length > 0) {
      suggestions.push({
        source_bill_id: source.id,
        surplus_usd: fromCents(surplusCents - remaining),
        targets,
      });
    }
  }

  return suggestions;
}
