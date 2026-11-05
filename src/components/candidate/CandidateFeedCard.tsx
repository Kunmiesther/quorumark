// Candidate discovery card. Keyed by candidate_id — never by symbol.
//
// Presentational only: every badge is derived from persisted lifecycle facts
// supplied by the server DTO. Nothing here recomputes a verdict.

import { Link } from "@tanstack/react-router";
import {
  agreementCount,
  candidateFreshness,
  candidateTpPrices,
  type CandidateLifecycleDto,
} from "@/lib/candidate/lifecycle";

const STALE_AFTER_MS = 15 * 60_000;

const VERDICT_LABEL: Record<string, { label: string; color: string }> = {
  shadow_endorse: { label: "ENDORSE", color: "var(--onixus-teal)" },
  shadow_weak_endorse: { label: "WEAK ENDORSE", color: "#FFD24A" },
  shadow_reject: { label: "REJECT", color: "var(--onixus-red)" },
  shadow_no_consensus: { label: "NO CONSENSUS", color: "rgba(230,232,240,0.7)" },
  shadow_unavailable: { label: "UNAVAILABLE", color: "rgba(230,232,240,0.45)" },
};

/**
 * "Asked and nobody answered" and "never asked" are different facts, and
 * reporting the second as the first invents an outage that did not happen.
 * `ai_shadow_pending` means no committee call has been recorded for this
 * candidate — say exactly that.
 */
function aiStateLabel(dto: CandidateLifecycleDto): { label: string; color: string } {
  if (dto.evaluation) {
    return dto.evaluation.availableRoles.length > 0
      ? { label: "AI evaluated", color: "var(--onixus-teal)" }
      : { label: "AI unavailable", color: "rgba(230,232,240,0.45)" };
  }
  if (dto.candidate.aiShadowState === "ai_shadow_unavailable") {
    return { label: "AI unavailable", color: "rgba(230,232,240,0.45)" };
  }
  return { label: "AI not asked", color: "rgba(230,232,240,0.45)" };
}

function Chip({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      className="rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider"
      style={{ borderColor: "rgba(255,255,255,0.12)", color }}
    >
      {children}
    </span>
  );
}

function num(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}

export function CandidateFeedCard({
  dto,
  selected,
  to,
}: {
  dto: CandidateLifecycleDto;
  selected: boolean;
  /** Route this card selects into, e.g. "/scout" or "/trade". */
  to: "/scout" | "/trade";
}) {
  const c = dto.candidate;
  const fresh = candidateFreshness(c, Date.now(), STALE_AFTER_MS);
  const ai = aiStateLabel(dto);
  const { agree, available } = agreementCount(dto.evaluation);
  const verdict = dto.evaluation ? VERDICT_LABEL[dto.evaluation.verdict] : null;
  const tps = candidateTpPrices(c);

  return (
    <Link
      to={to}
      search={(prev: Record<string, unknown>) => ({ ...prev, candidate: c.candidateId })}
      replace={false}
      data-testid="candidate-card"
      data-candidate-id={c.candidateId}
      data-selected={selected ? "true" : "false"}
      className="block rounded-2xl border bg-black p-3 transition-colors hover:border-white/25"
      style={{
        borderColor: selected ? "var(--onixus-teal)" : "rgba(255,255,255,0.08)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-white">
            {c.symbol.replace("-", "/")}
          </div>
          <div className="font-mono text-[9.5px] uppercase tracking-wide text-white/40">
            {c.strategy} · {c.direction} · {c.timeframe}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Chip color={fresh === "current" ? "var(--onixus-teal)" : "#FFD24A"}>
            {selected ? "Active" : fresh === "current" ? "Current" : "Historical"}
          </Chip>
          <Chip
            color={
              c.technicalDecision === "technical_validated"
                ? "var(--onixus-teal)"
                : "var(--onixus-red)"
            }
          >
            {c.technicalDecision === "technical_validated" ? "Technical ✓" : "Technical ✗"}
          </Chip>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px]">
        <div>
          <div className="text-white/35">Entry</div>
          <div className="text-white/75">
            {c.entryZone ? `${num(c.entryZone.low)}–${num(c.entryZone.high)}` : "—"}
          </div>
        </div>
        <div>
          <div className="text-white/35">Invalidation</div>
          <div className="text-white/75">{num(c.invalidation)}</div>
        </div>
        <div>
          <div className="text-white/35">TP levels</div>
          <div className="text-white/75">{tps.length ? tps.map((p) => num(p)).join(" / ") : "—"}</div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Chip color={ai.color}>{ai.label}</Chip>
        {verdict ? <Chip color={verdict.color}>{verdict.label}</Chip> : null}
        <Chip color="rgba(230,232,240,0.7)">
          {available > 0 ? `${agree}/${available} agree` : "0 seats"}
        </Chip>
        <Chip color={dto.orderState ? "var(--onixus-hot-blue)" : "rgba(230,232,240,0.4)"}>
          {dto.orderState ? `Order ${dto.orderState}` : "No live order associated"}
        </Chip>
      </div>

      <p className="mt-2 truncate font-mono text-[9px] text-white/25">
        {c.candidateId} ·{" "}
        {new Date(c.candleCloseAt).toISOString().slice(0, 16).replace("T", " ")} UTC
      </p>
    </Link>
  );
}
