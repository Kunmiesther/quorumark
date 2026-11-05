/**
 * Section 1 — System Status. The hero.
 *
 * One line answers the page's question; the five subsystems below it show
 * the working. When something fails, the affected subsystem and its reason
 * are already on screen — no drill-down, no tooltip.
 */
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import {
  Eyebrow,
  StatusDot,
  SubsystemRow,
  TONE_TEXT,
  relTime,
} from "@/components/exchanges/trust/primitives";
import type { TrustCenterData } from "@/hooks/useTrustCenter";
import { cn } from "@/lib/utils";

export function SystemStatusPanel({ data }: { data: TrustCenterData }) {
  const { overall, subsystems, lastHealthCheckAt } = data;

  return (
    <SurfaceCard className="p-0">
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <Eyebrow>Overall system status</Eyebrow>
          <div className="mt-2 flex items-center gap-3">
            <StatusDot tone={overall.tone} pulse className="h-3 w-3" />
            <h1
              className={cn(
                "text-[30px] font-semibold leading-none sm:text-[36px]",
                TONE_TEXT[overall.tone],
              )}
              style={{ letterSpacing: "-0.02em" }}
            >
              {overall.state}
            </h1>
          </div>
          <p className="mt-2.5 max-w-[46ch] text-[12.5px] leading-relaxed text-white/55">
            {overall.detail}
          </p>
        </div>

        <div className="shrink-0 text-left sm:text-right">
          <Eyebrow>Last health check</Eyebrow>
          <p className="mt-1.5 text-[15px] font-semibold tabular-nums text-white/85">
            {relTime(lastHealthCheckAt)}
          </p>
          <p className="mt-0.5 text-[10.5px] text-white/35">Refreshes every 15s</p>
        </div>
      </div>

      <div className="border-t border-white/[0.06] px-5 py-1">
        {subsystems.map((s) => (
          <SubsystemRow
            key={s.key}
            name={s.name}
            state={s.state}
            tone={s.tone}
            detail={s.detail}
            at={s.at ? relTime(s.at) : null}
          />
        ))}
      </div>
    </SurfaceCard>
  );
}
