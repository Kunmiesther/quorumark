/**
 * Owner-scoped, READ-ONLY venue-rejection diagnostics.
 *
 * Railway containers rotate and their stdout disappears with the deployment.
 * The durable record therefore lives in `public.order_audit`
 * (`phase = 'exchange_response'`), written service-side by the broker. This
 * module only SELECTs — it never inserts, updates, cancels, resizes, or
 * closes anything, and RLS ("Users read own audit rows") scopes every read to
 * the caller's own rows.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface VenueRejectionRow {
  observed_at: string;
  idempotency_key: string | null;
  candidate_id: string | null;
  evidence_hash: string | null;
  connection_id: string | null;
  symbol: string | null;
  side: string | null;
  order_type: string | null;
  requested_size: number | null;
  requested_price: number | null;
  http_status: number | null;
  venue_code: string | null;
  venue_category: string | null;
  venue_message: string | null;
  signer_mapping: string | null;
  signer_outcome: string | null;
  signer_revision: string | null;
  reject_reason: string | null;
}

function pick(o: Record<string, unknown> | null, k: string): string | null {
  const v = o?.[k];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function pickNum(o: Record<string, unknown> | null, k: string): number | null {
  const v = o?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const listVenueRejections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<VenueRejectionRow[]> => {
    const { data, error } = await context.supabase
      .from("order_audit")
      .select(
        "created_at, idempotency_key, connection_id, symbol, side, order_type, reject_reason, sanitized_response",
      )
      .eq("phase", "exchange_response")
      .not("reject_reason", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    return (data ?? []).map((r) => {
      const sr = (r.sanitized_response ?? null) as Record<string, unknown> | null;
      const vr = (sr?.["venue_reject"] ?? null) as Record<string, unknown> | null;
      return {
        observed_at: pick(vr, "observed_at") ?? String(r.created_at),
        idempotency_key: r.idempotency_key ?? null,
        candidate_id: pick(vr, "candidate_id"),
        evidence_hash: pick(vr, "evidence_hash"),
        connection_id: r.connection_id ?? null,
        symbol: r.symbol ?? null,
        side: r.side ?? null,
        order_type: r.order_type ?? null,
        requested_size: pickNum(vr, "requested_size"),
        requested_price: pickNum(vr, "requested_price"),
        http_status: pickNum(vr, "http_status"),
        venue_code: pick(vr, "venue_code"),
        venue_category: pick(vr, "venue_category"),
        venue_message: pick(vr, "venue_message"),
        signer_mapping: pick(vr, "signer_mapping"),
        signer_outcome: pick(vr, "signer_outcome"),
        signer_revision: pick(vr, "signer_revision"),
        reject_reason: r.reject_reason ?? null,
      };
    });
  });
