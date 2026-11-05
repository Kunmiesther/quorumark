/**
 * Slot lifecycle types — kept in a separate file so pure helpers can be
 * tested without importing the server function file.
 */

export type PaperSlotState =
  | "unassigned"
  | "reserved"
  | "committed"
  | "active"
  | "hedge_reserved"
  | "recovery_reserved";

export interface SlotRow {
  id: string;
  slotIndex: number;
  state: PaperSlotState;
  assignedSymbol: string | null;
  assignedDirection: "long" | "short" | null;
  positionId: string | null;
  reservationExpiresAt: number | null;
}
