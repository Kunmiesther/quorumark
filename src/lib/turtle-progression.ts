/**
 * Turtle progression & points helpers (P4 + P4-CLEANUP).
 *
 * INVARIANTS:
 *  - Points have NO cash value. They never modify Risk Capital, leverage,
 *    order size, or execution. Cosmetic only.
 *  - Turtle cosmetics never gate Life Map access or trading behavior.
 *  - The six official turtles reference existing strategies.slug + suit_name;
 *    do NOT invent new names.
 *  - The award catalog is anti-farming: no repeatable per-obligation-creation
 *    milestone. See resolveAwards() for the full eligibility mirror of the
 *    SQL trigger `award_points_from_history()`.
 */

export const POINTS_HAVE_NO_CASH_VALUE = true as const;

export interface OfficialTurtle {
  readonly slug: string;
  readonly suit: string;
}

export const OFFICIAL_TURTLES: readonly OfficialTurtle[] = [
  { slug: "dca", suit: "The Accumulator" },
  { slug: "break-retest", suit: "The Vanguard" },
  { slug: "rsi-divergence", suit: "The Sniper" },
  { slug: "ema-cross", suit: "The Scout" },
  { slug: "liq-hunting", suit: "The Hunter" },
  { slug: "funding-arb", suit: "The Arbiter" },
] as const;

export const POINTS_PER_LEVEL = 100;

export function levelForPoints(points: number): number {
  if (!Number.isFinite(points) || points < 0) return 1;
  return Math.floor(points / POINTS_PER_LEVEL) + 1;
}

export function pointsToNextLevel(points: number): number {
  if (!Number.isFinite(points) || points < 0) return POINTS_PER_LEVEL;
  const current = levelForPoints(points);
  return current * POINTS_PER_LEVEL - points;
}

export function isEssentialFeatureLocked(
  _tier?: string,
  _points?: number,
  _level?: number,
): boolean {
  return false;
}

// ---------------------------------------------------------------------
// Milestone catalog (mirror of milestone_definitions after P4-CLEANUP)
// ---------------------------------------------------------------------

export type MilestoneCode =
  | "first_obligation"
  | "first_roof_setup"
  | "first_ride_setup"
  | "first_category_setup"
  | "lifemap_complete"
  | "obligation_paid_on_time"
  | "obligation_funded"
  | "overdue_cleared"
  | "category_month_complete"
  | "streak_month";

export type MilestoneScope = "once_per_user" | "once_per_user_category" | "series_period";

export const MILESTONE_SCOPE: Record<MilestoneCode, MilestoneScope> = {
  first_obligation: "once_per_user",
  first_roof_setup: "once_per_user",
  first_ride_setup: "once_per_user",
  first_category_setup: "once_per_user_category",
  lifemap_complete: "once_per_user",
  obligation_paid_on_time: "series_period",
  obligation_funded: "series_period",
  overdue_cleared: "series_period",
  category_month_complete: "series_period",
  streak_month: "series_period",
};

export type HistoryEvent = "created" | "funded" | "paid" | "updated" | "overdue" | "deleted";

/**
 * Back-compat: previously mapped 'created' -> a repeatable per-obligation
 * award. That is FARMABLE and has been removed. This helper now only maps
 * events that are still legally attached to a single milestone code; use
 * `resolveAwards()` for the full multi-milestone eligibility.
 */
export function eventToMilestone(event: HistoryEvent | string): MilestoneCode | null {
  switch (event) {
    case "funded":
      return "obligation_funded";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------
// Idempotency keys (must match SQL exactly)
// ---------------------------------------------------------------------

export function idempotencyKeyOncePerUser(userId: string, code: MilestoneCode): string {
  return `${userId}:${code}`;
}

export function idempotencyKeyOncePerUserCategory(
  userId: string,
  code: MilestoneCode,
  categoryId: string,
): string {
  return `${userId}:${code}:${categoryId}`;
}

export function idempotencyKeySeriesPeriod(
  userId: string,
  seriesId: string,
  billingPeriod: string,
  code: MilestoneCode,
): string {
  return `${userId}:${seriesId}:${billingPeriod}:${code}`;
}

/**
 * Legacy signature (kept for existing call sites/tests). For series_period
 * awards prefer `idempotencyKeySeriesPeriod`.
 */
export function idempotencyKey(
  userId: string,
  milestone: MilestoneCode | string,
  obligationId: string,
  yyyyMm: string,
): string {
  return `${userId}:${milestone}:${obligationId}:${yyyyMm}`;
}

// ---------------------------------------------------------------------
// resolveAwards() — pure mirror of the SQL trigger eligibility
// ---------------------------------------------------------------------

export interface ResolveAwardsInput {
  event: HistoryEvent | string;
  oldStatus?: string | null;
  newStatus?: string | null;
  amount?: number | null;
  monthlyTarget?: number | null;
  dueDate?: string | Date | null; // ISO date or Date
  paidAt?: string | Date | null; // ISO datetime or Date
  billingPeriod?: string | null; // YYYY-MM
  nowYyyyMm: string; // caller supplies "now" period
  categoryKey?: string | null; // 'roof' | 'ride' | ...
  archived?: boolean;
  seriesId?: string | null;
}

function toDate(x: string | Date | null | undefined): Date | null {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  return isNaN(d.getTime()) ? null : d;
}

export function resolveAwards(input: ResolveAwardsInput): MilestoneCode[] {
  const out: MilestoneCode[] = [];
  if (input.archived) return out;

  const amt = Number(input.amount ?? 0);
  const mft = Number(input.monthlyTarget ?? 0);
  if (!(amt > 0 || mft > 0)) return out;

  const { event, oldStatus, newStatus, billingPeriod, nowYyyyMm, categoryKey, seriesId } = input;

  if (event === "created") {
    out.push("first_obligation");
    if (categoryKey) out.push("first_category_setup");
    if (categoryKey === "roof") out.push("first_roof_setup");
    if (categoryKey === "ride") out.push("first_ride_setup");
    return out;
  }

  if (event === "funded") {
    if (newStatus === "funded" && oldStatus !== "funded" && seriesId && billingPeriod) {
      out.push("obligation_funded");
    }
    return out;
  }

  if (event === "paid" && seriesId && billingPeriod) {
    if (oldStatus === "overdue") {
      out.push("overdue_cleared");
      return out;
    }
    const due = toDate(input.dueDate);
    const paid = toDate(input.paidAt);
    if (
      due &&
      paid &&
      paid.getTime() <= due.getTime() + 24 * 60 * 60 * 1000 - 1 && // paid_at::date <= due_date
      billingPeriod <= nowYyyyMm
    ) {
      // Compare by date only (strip paid time-of-day)
      const paidDateStr = paid.toISOString().slice(0, 10);
      const dueDateStr =
        typeof input.dueDate === "string"
          ? input.dueDate.slice(0, 10)
          : due.toISOString().slice(0, 10);
      if (paidDateStr <= dueDateStr) {
        out.push("obligation_paid_on_time");
      }
    }
    return out;
  }

  return out;
}
