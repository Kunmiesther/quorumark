/**
 * TAKE-PROFIT COUNCIL STATUS — read-only.
 *
 * Shows, per open live position: the pending-review banner, candle progress
 * 0/3 → 3/3, review status, the council's final decision and the venue
 * acknowledgement (order id) when a take-profit or exit was submitted.
 *
 * Presentation only. This component never places, cancels or modifies an
 * order; every value is read back from what the backend already persisted.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { candleProgress, tpStatusLabel, type TpState } from "@/lib/live/tpCouncil";
import { tpOrderEvidence } from "@/lib/live/venueOrderEvidence";
import { readPositionProtection } from "@/lib/live/positionProtection";
import { PositionProtectionReadout } from "./PositionProtectionReadout";
import { cn } from "@/lib/utils";

interface PositionLite {
  id: string;
  pair: string;
  side: string;
  size: number;
  tp_state: TpState;
  tp_execution_timeframe: string;
  tp_candles_required: number;
  tp_fill_ts: string | null;
  opened_at: string;
  tp_price: number | null;
  tp_venue_order_id: string | null;
  open_orders: unknown;
  synced_at: string | null;
  tp_last_decision: string | null;
  tp_last_reviewed_at: string | null;
}

interface ReviewLite {
  position_id: string;
  review_seq: number;
  status: string;
  decision: string | null;
  rationale: string | null;
  venue_order_id: string | null;
  reject_reason: string | null;
  degraded: boolean;
  completed_at: string | null;
}

const STATE_TONE: Record<string, string> = {
  PENDING_COUNCIL_REVIEW: "text-[#4EA8FF] border-[#4EA8FF]/40 bg-[#4EA8FF]/10",
  REVIEW_IN_PROGRESS: "text-[#9945FF] border-[#9945FF]/40 bg-[#9945FF]/10",
  TP_SET: "text-[#14F195] border-[#14F195]/40 bg-[#14F195]/10",
  PARTIAL_TP_SET: "text-[#14F195] border-[#14F195]/40 bg-[#14F195]/10",
  HOLD_WITHOUT_TP: "text-amber-300 border-amber-400/40 bg-amber-400/10",
  TRAILING: "text-[#4EA8FF] border-[#4EA8FF]/40 bg-[#4EA8FF]/10",
  EXIT_SUBMITTED: "text-rose-300 border-rose-400/40 bg-rose-400/10",
  CLOSED: "text-white/50 border-white/15 bg-white/5",
};

export function TpCouncilPanel() {
  const positions = useQuery({
    queryKey: ["tp-council", "positions"],
    refetchInterval: 20_000,
    queryFn: async (): Promise<PositionLite[]> => {
      const { data, error } = await supabase
        .from("positions")
        .select(
          "id,pair,side,size,tp_state,tp_execution_timeframe,tp_candles_required,tp_fill_ts," +
            "opened_at,tp_price,tp_venue_order_id,open_orders,synced_at,tp_last_decision,tp_last_reviewed_at",
        )
        .eq("source", "live")
        .eq("status", "open")
        .order("opened_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PositionLite[];
    },
  });

  const reviews = useQuery({
    queryKey: ["tp-council", "reviews"],
    refetchInterval: 20_000,
    queryFn: async (): Promise<ReviewLite[]> => {
      const { data, error } = await supabase
        .from("live_tp_council_reviews")
        .select(
          "position_id,review_seq,status,decision,rationale,venue_order_id,reject_reason,degraded,completed_at",
        )
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as ReviewLite[];
    },
  });

  const rows = positions.data ?? [];
  if (!rows.length) {
    return (
      <p className="text-xs text-white/40">
        No open live position. Take-profit is decided by the council three closed candles after a
        fill — never at entry.
      </p>
    );
  }

  const now = Date.now();

  return (
    <div className="space-y-3">
      {rows.map((p) => {
        const fillMs = Date.parse(p.tp_fill_ts ?? p.opened_at);
        let progress;
        try {
          progress = candleProgress(
            fillMs,
            now,
            p.tp_execution_timeframe || "15m",
            p.tp_candles_required || 3,
          );
        } catch {
          progress = { closed: 0, required: 3, due: false, dueAtMs: 0, label: "0/3" };
        }
        const latest = (reviews.data ?? []).find((r) => r.position_id === p.id);
        const tpEvidence = tpOrderEvidence(p.tp_state, p.tp_venue_order_id, p.open_orders);
        const protection = readPositionProtection(
          p.open_orders,
          p.pair,
          p.side,
          p.tp_venue_order_id,
        );
        const venueTpVisible = protection.takeProfits.length > 0;
        const tone = venueTpVisible
          ? STATE_TONE["TP_SET"]
          : tpEvidence === "unverified"
            ? STATE_TONE["HOLD_WITHOUT_TP"]
            : (STATE_TONE[p.tp_state] ?? STATE_TONE["CLOSED"]);

        return (
          <div key={p.id} className="rounded-md border border-white/10 bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-white/80">{p.pair}</span>
              <span className="text-[10px] uppercase tracking-wide text-white/40">
                {String(p.side)} · {p.size} · {p.tp_execution_timeframe || "15m"}
              </span>
              <span
                className={cn(
                  "ml-auto rounded border px-2 py-0.5 text-[10px] font-semibold tracking-wide",
                  tone,
                )}
              >
                {venueTpVisible
                  ? "TP visible in venue snapshot"
                  : tpEvidence === "unverified"
                    ? "TP not verified at venue"
                    : tpStatusLabel(p.tp_state, progress)}
              </span>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <div className="flex gap-1">
                {Array.from({ length: progress.required }).map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1.5 w-8 rounded-full",
                      i < progress.closed ? "bg-[#14F195]" : "bg-white/10",
                    )}
                  />
                ))}
              </div>
              <span className="font-mono text-[10px] text-white/50">
                {progress.label} closed candles
              </span>
            </div>

            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
              <div>
                <dt className="text-white/35">Review</dt>
                <dd className="text-white/70">
                  {latest ? `#${latest.review_seq} ${latest.status}` : "not started"}
                </dd>
              </div>
              <div>
                <dt className="text-white/35">Decision</dt>
                <dd className="text-white/70">{p.tp_last_decision ?? latest?.decision ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-white/35">Bot TP target (not order proof)</dt>
                <dd className="font-mono text-white/70">{p.tp_price ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-white/35">Venue order</dt>
                <dd className="font-mono text-white/70">
                  {p.tp_venue_order_id ?? latest?.venue_order_id ?? "—"}
                </dd>
              </div>
            </dl>
            <div className="mt-3 rounded-xl bg-black/20 p-3">
              <PositionProtectionReadout protection={protection} syncedAt={p.synced_at} />
            </div>
            {tpEvidence === "unverified" && (
              <p role="alert" className="mt-2 text-[11px] leading-snug text-amber-200">
                A stored order ID is not proof of a resting TP. No matching order is visible in the
                last venue reconciliation
                {p.synced_at ? ` (${new Date(p.synced_at).toLocaleString()})` : ""}. This panel has
                not changed the trade.
              </p>
            )}

            {(latest?.rationale || latest?.reject_reason) && (
              <p className="mt-2 text-[11px] leading-snug text-white/45">
                {latest?.reject_reason ? `Not submitted (${latest.reject_reason}). ` : ""}
                {latest?.rationale ?? ""}
                {latest?.degraded ? " (degraded — council unavailable)" : ""}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
