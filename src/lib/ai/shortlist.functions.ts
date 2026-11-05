/**
 * SHORTLIST FEED — read-only view of the persisted committee cycle.
 *
 * AUTHORITY: NONE. Reads `committee_cycles` + `committee_shortlist` for the
 * authenticated user so the desk can render the real funnel:
 * candidate → strategist opinions → ONYX rank → entry plan / pending entry
 * → rejection reason. No writes, no execution edge.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface ShortlistSeatDto {
  role: string;
  available: boolean;
  direction: string | null;
  confidence: number | null;
  reason: string | null;
}

export interface ShortlistRowDto {
  id: string;
  symbol: string;
  direction: string | null;
  state: string;
  rank: number | null;
  score: number | null;
  netEdgeBps: number | null;
  rejectionReason: string | null;
  seats: ShortlistSeatDto[];
  entryPlan: { [k: string]: Json } | null;
  riskObjection: { [k: string]: Json } | null;
  selected: boolean;
}

export interface ShortlistCycleDto {
  cycleId: string | null;
  cycleKey: string | null;
  book: string | null;
  status: string | null;
  noTradeReason: string | null;
  universeSize: number | null;
  candidateCount: number | null;
  startedAt: string | null;
  rows: ShortlistRowDto[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const obj = (v: unknown): { [k: string]: Json } | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as { [k: string]: Json }) : null;

function seatsOf(v: unknown): ShortlistSeatDto[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const s = obj(raw) ?? {};
    return {
      role: String(s.role ?? "unknown"),
      available: s.available === true,
      direction: typeof s.direction === "string" ? s.direction : null,
      confidence: num(s.confidence),
      reason: typeof s.reason === "string" ? s.reason : null,
    };
  });
}

export const getShortlistCycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const book = i.book === "live" ? "live" : "paper";
    return { book: book as "paper" | "live" };
  })
  .handler(async ({ data, context }): Promise<ShortlistCycleDto> => {
    const { supabase, userId } = context;

    const { data: cycle, error: cycleError } = await supabase
      .from("committee_cycles")
      .select(
        "id, cycle_key, book, status, no_trade_reason, universe_size, candidate_count, started_at",
      )
      .eq("user_id", userId)
      .eq("book", data.book)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cycleError) throw new Error(`Council cycle read failed: ${cycleError.message}`);
    if (!cycle) {
      return {
        cycleId: null,
        cycleKey: null,
        book: data.book,
        status: null,
        noTradeReason: null,
        universeSize: null,
        candidateCount: null,
        startedAt: null,
        rows: [],
      };
    }

    const { data: rows, error: rowsError } = await supabase
      .from("committee_shortlist")
      .select(
        "id, symbol, direction, state, rank, total_score, expected_net_edge_bps, rejection_reason, " +
          "seat_decisions, entry_plan, risk_objection",
      )
      .eq("cycle_id", cycle.id)
      .order("rank", { ascending: true, nullsFirst: false })
      .limit(50);

    if (rowsError) throw new Error(`Council seat read failed: ${rowsError.message}`);
    const list = (rows ?? []) as unknown as Array<Record<string, unknown>>;

    return {
      cycleId: cycle.id as string,
      cycleKey: (cycle.cycle_key as string) ?? null,
      book: (cycle.book as string) ?? data.book,
      status: (cycle.status as string) ?? null,
      noTradeReason: (cycle.no_trade_reason as string) ?? null,
      universeSize: num(cycle.universe_size),
      candidateCount: num(cycle.candidate_count),
      startedAt: (cycle.started_at as string) ?? null,
      rows: list.map((r) => ({
        id: r.id as string,
        symbol: (r.symbol as string) ?? "—",
        direction: (r.direction as string) ?? null,
        state: (r.state as string) ?? "reviewing",
        rank: num(r.rank),
        score: num(r.total_score),
        netEdgeBps: num(r.expected_net_edge_bps),
        rejectionReason: (r.rejection_reason as string) ?? null,
        seats: seatsOf(r.seat_decisions),
        entryPlan: obj(r.entry_plan),
        riskObjection: obj(r.risk_objection),
        selected: (r.state as string) === "selected",
      })),
    };
  });
