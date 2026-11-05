/**
 * Section 3 — Trust Monitor. The heartbeat.
 *
 * The one place that answers "is anything actually happening?". Every row is
 * a persisted record with a timestamp; a row with no record says "none yet"
 * rather than borrowing a neighbouring value.
 *
 * When execution is waiting, the reason and the recommended action are shown
 * together — a reason with no next step is just an apology.
 */
import { PauseCircle } from "lucide-react";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import {
  Eyebrow,
  Metric,
  SectionHeading,
  StatusDot,
  TONE_TEXT,
  relTime,
} from "@/components/exchanges/trust/primitives";
import type { TrustCenterData } from "@/hooks/useTrustCenter";
import { cn } from "@/lib/utils";

export function TrustMonitorPanel({ data }: { data: TrustCenterData }) {
  const { monitor, execution, queueSize, openPositions, lastHealthCheckAt } = data;

  return (
    <SurfaceCard>
      <SectionHeading
        title="Trust monitor"
        subtitle="Live operational heartbeat. Every row is a persisted record, not an estimate."
      />

      {execution.waiting && (
        <div className="mb-4 rounded-2xl bg-amber-500/[0.08] p-3.5">
          <div className="flex items-start gap-2.5">
            <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold text-amber-100">Execution waiting</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-amber-100/85">
                {execution.reason}
              </p>
              {execution.recommendedAction && (
                <p className="mt-2 text-[11.5px] leading-relaxed text-amber-100/70">
                  <span className="font-semibold">Recommended:</span> {execution.recommendedAction}
                </p>
              )}
              {execution.at && (
                <p className="mt-1.5 text-[10.5px] tabular-nums text-amber-100/50">
                  Since {relTime(execution.at)}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="divide-y divide-white/[0.05]">
        {monitor.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-3 py-2.5">
            <div className="flex min-w-0 items-start gap-2.5">
              <StatusDot tone={row.tone} className="mt-1.5" />
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-white/85">{row.label}</p>
                <p className="mt-0.5 break-words text-[11px] leading-relaxed text-white/45 [overflow-wrap:anywhere]">
                  {row.summary ?? "None recorded yet"}
                </p>
              </div>
            </div>
            <p
              className={cn(
                "shrink-0 text-[11.5px] font-semibold tabular-nums",
                row.at ? "text-white/70" : TONE_TEXT.idle,
              )}
            >
              {row.at ? relTime(row.at) : "—"}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-white/[0.06] pt-4 sm:grid-cols-3">
        <Metric label="Open positions" value={openPositions === null ? "—" : openPositions} />
        <Metric label="Queue size" value={queueSize === null ? "—" : queueSize} />
        <Metric label="Last sync" value={relTime(lastHealthCheckAt)} />
      </div>

      <p className="mt-3 text-[10.5px] leading-relaxed text-white/30">
        <Eyebrow className="inline">Note</Eyebrow> — the AI committee is advisory. It never
        approves, sizes, signs, or delays a trade, and an unavailable model is never counted as
        agreement.
      </p>
    </SurfaceCard>
  );
}
