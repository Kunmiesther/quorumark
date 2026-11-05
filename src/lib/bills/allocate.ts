/**
 * Life Map v2 — allocation pure function.
 *
 * Given the ordered active bills for a user, the amount ALREADY covered
 * per bill for the current period, and a signed PnL delta from a single
 * closed paper trade, decide how that delta redistributes across bills.
 *
 * Rules (honesty first):
 *   - Positive delta fills bills in priority order (lower priority number
 *     = paid first). Overflow spills to the next bill. Anything left after
 *     the last bill is `unallocated`.
 *   - Negative delta DRAINS bills in REVERSE priority order (least-priority
 *     first). Coverage is allowed to go DOWN but never below zero. Anything
 *     left unabsorbed after the highest-priority bill hits zero is
 *     `unabsorbed` (a real loss the user's coverage couldn't fully absorb).
 *   - Zero delta is a no-op.
 *
 * Determinism: this function performs no I/O, uses no clocks, and does not
 * mutate its inputs. It is safe to run twice — same inputs, same outputs.
 * Numeric handling uses cents (integer math) internally to avoid float drift.
 */

export interface BillForAlloc {
  id: string;
  /** Full amount to cover this period, in USD (dollars). */
  amount_usd: number;
  /** Lower = paid first. */
  priority: number;
  /** Tiebreak within the same priority (ISO timestamp string). */
  created_at: string;
}

export interface AllocateInput {
  bills: readonly BillForAlloc[];
  /** Map of bill_id → USD already covered this period (must be >= 0). */
  covered: Readonly<Record<string, number>>;
  /** Signed USD delta from a single closed trade. */
  delta_usd: number;
}

export interface AllocationOp {
  bill_id: string;
  /** Signed USD amount to insert (positive = fill, negative = drain). */
  delta_usd: number;
}

export interface AllocateResult {
  ops: AllocationOp[];
  /** Positive delta not absorbed by any bill (all bills at cap). */
  unallocated_usd: number;
  /** Negative delta not absorbed by any bill (all bills at zero). */
  unabsorbed_usd: number;
}

const CENTS = 100;

function toCents(usd: number): number {
  // Round to nearest cent to keep math integer. bills.amount_usd is
  // numeric(12,2); covered comes from summed numeric(14,4) allocations
  // so we tolerate sub-cent drift on the input.
  return Math.round(usd * CENTS);
}

function fromCents(c: number): number {
  const v = c / CENTS;
  return v === 0 ? 0 : v; // normalize -0 → 0
}

function sortedByPriority(bills: readonly BillForAlloc[]): BillForAlloc[] {
  return [...bills].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

export function allocate(input: AllocateInput): AllocateResult {
  const deltaCents = toCents(input.delta_usd);
  if (deltaCents === 0 || input.bills.length === 0) {
    return {
      ops: [],
      unallocated_usd: input.delta_usd > 0 ? input.delta_usd : 0,
      unabsorbed_usd: input.delta_usd < 0 ? input.delta_usd : 0,
    };
  }

  const ordered = sortedByPriority(input.bills);
  const ops: AllocationOp[] = [];

  if (deltaCents > 0) {
    let remaining = deltaCents;
    for (const bill of ordered) {
      if (remaining <= 0) break;
      const capCents = toCents(bill.amount_usd);
      const filledCents = toCents(input.covered[bill.id] ?? 0);
      const roomCents = Math.max(0, capCents - filledCents);
      if (roomCents <= 0) continue;
      const take = Math.min(roomCents, remaining);
      ops.push({ bill_id: bill.id, delta_usd: fromCents(take) });
      remaining -= take;
    }
    return {
      ops,
      unallocated_usd: fromCents(remaining),
      unabsorbed_usd: 0,
    };
  }

  // Negative — drain in REVERSE priority order.
  let toDrain = -deltaCents; // positive magnitude
  for (const bill of [...ordered].reverse()) {
    if (toDrain <= 0) break;
    const filledCents = toCents(input.covered[bill.id] ?? 0);
    if (filledCents <= 0) continue;
    const take = Math.min(filledCents, toDrain);
    ops.push({ bill_id: bill.id, delta_usd: -fromCents(take) });
    toDrain -= take;
  }
  return {
    ops,
    unallocated_usd: 0,
    unabsorbed_usd: toDrain === 0 ? 0 : -fromCents(toDrain),
  };
}

/**
 * Convenience: derive the UTC YYYY-MM period key for a timestamp.
 * Weekly and one-time bills share the same monthly pool boundary in v2.
 */
export function periodKeyFor(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
