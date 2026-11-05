/**
 * Pure helper mirroring the DB trigger's event mapping for
 * public.life_obligations -> public.life_obligation_history.
 *
 * INSERT => 'created'
 * DELETE => 'deleted'
 * UPDATE: status changed to 'paid' | 'funded' | 'overdue' => that event
 *         any other change => 'updated'
 */
export type LifeHistoryEvent =
  | "created"
  | "updated"
  | "paid"
  | "funded"
  | "overdue"
  | "deleted";

export type LifeObligationStatus =
  | "upcoming"
  | "paid"
  | "funded"
  | "overdue"
  | (string & {});

export type LifeObligationOp = "INSERT" | "UPDATE" | "DELETE";

const TRANSITION_EVENTS: Record<string, LifeHistoryEvent> = {
  paid: "paid",
  funded: "funded",
  overdue: "overdue",
};

export function mapObligationEvent(
  op: LifeObligationOp,
  oldStatus: LifeObligationStatus | null | undefined,
  newStatus: LifeObligationStatus | null | undefined,
): LifeHistoryEvent {
  if (op === "INSERT") return "created";
  if (op === "DELETE") return "deleted";
  if (newStatus && newStatus !== oldStatus && TRANSITION_EVENTS[newStatus]) {
    return TRANSITION_EVENTS[newStatus];
  }
  return "updated";
}
