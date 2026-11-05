// SHADOW ANALYSIS — calibration + participation readout for the committee.
//
// Presentational only. Two distinct classes of number are shown and never
// mixed: (1) participation/availability metrics, derived from persisted
// evaluations alone, and (2) outcome-linked metrics, which require a closed
// trade attributable to the same candidate id. Unattributed evaluations are
// reported as "awaiting outcome" — never joined to unrelated trades.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCommitteeCalibration } from "@/lib/ai/calibration.functions";
import type { BucketMetrics } from "@/lib/ai/calibration/metrics";
import type { IntelligenceMetrics } from "@/lib/ai/intelligence/metrics";
import { aiReviewLabel } from "@/lib/ai/committee/roles";

const LABEL: Record<string, string> = {
  overall: "Overall",
  shadow_endorse: "Endorse",
  shadow_weak_endorse: "Weak endorse",
  shadow_reject: "Reject",
  shadow_no_consensus: "No consensus",
  shadow_unavailable: "Unavailable",
  strong: "Strong",
  moderate: "Moderate",
  weak: "Weak",
  avoid: "Avoid",
  insufficient: "Insufficient",
};



function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}
function num(v: number | null, digits = 2): string {
  return v == null ? "—" : v.toFixed(digits);
}

function Row({ b }: { b: BucketMetrics }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] py-1 first:border-t-0">
      <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">
        {LABEL[b.key] ?? b.key}
      </span>
      {b.sufficient ? (
        <span className="font-mono text-[10px] text-white/70">
          n={b.sample} · win {pct(b.winRate)} · R {num(b.meanR)} · Brier {num(b.brier)}
        </span>
      ) : (
        <span className="font-mono text-[10px] text-white/30">
          n={b.sample} · below minimum sample
        </span>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.015] px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="font-mono text-[12px] text-white/80">{value}</div>
    </div>
  );
}

export function CommitteeCalibrationPanel({
  symbol,
  metrics,
}: {
  symbol?: string | null;
  /** Participation metrics from the intelligence feed, when available. */
  metrics?: IntelligenceMetrics | null;
}) {
  const fetchCalibration = useServerFn(getCommitteeCalibration);
  const q = useQuery({
    queryKey: ["committee-calibration", symbol ?? null],
    queryFn: () => fetchCalibration({ data: { symbol: symbol ?? null } }),
    refetchInterval: 120_000,
    retry: false,
  });

  const report = q.data ?? null;
  const w = (k: "1h" | "24h" | "7d") => metrics?.windows.find((x) => x.key === k) ?? null;

  return (
    <section
      className="rounded-2xl border border-white/[0.08] bg-black p-3"
      data-testid="committee-calibration"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-white/55">
          AI calibration
        </h3>
        <span
          className="rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider"
          style={{
            borderColor: "rgba(255,210,74,0.4)",
            color: "#FFD24A",
            background: "rgba(255,210,74,0.06)",
          }}
        >
          Shadow analysis
        </span>
      </div>
      <p className="mt-1 font-mono text-[9px] uppercase tracking-wide text-white/35">
        Shadow analysis — does not control live trading
      </p>

      {metrics ? (
        <>
          <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <Stat label="Evals 1h" value={String(w("1h")?.evaluations ?? 0)} />
            <Stat label="Evals 24h" value={String(w("24h")?.evaluations ?? 0)} />
            <Stat label="Evals 7d" value={String(w("7d")?.evaluations ?? 0)} />
            <Stat label="3/3 seats (24h)" value={pct(w("24h")?.fullParticipation ?? null)} />
            <Stat label="Agreement (24h)" value={pct(w("24h")?.agreementRate ?? null)} />
            <Stat
              label="Direction mix"
              value={`${metrics.directions.long}L / ${metrics.directions.short}S / ${metrics.directions.no_trade}N`}
            />
            <Stat label="Matched outcomes" value={String(metrics.matchedOutcomes)} />
            <Stat label="Awaiting outcome" value={String(metrics.awaitingOutcome)} />
          </div>

          <div className="mt-2">
            {metrics.seats.map((s, i) => (
              <div
                key={s.role}
                className="flex items-center justify-between gap-2 border-t border-white/[0.06] py-1"
              >
                <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">
                  {aiReviewLabel(i)}
                </span>
                <span className="font-mono text-[10px] text-white/70">
                  {s.available}/{s.asked} available · {pct(s.availabilityRate)} ·{" "}
                  {s.medianLatencyMs == null ? "—" : `${s.medianLatencyMs} ms median`}
                  {s.lastUnavailableReason ? ` · last fail: ${s.lastUnavailableReason}` : ""}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {q.isLoading ? (
        <p className="mt-3 text-[11px] text-white/40">Loading outcome calibration…</p>
      ) : !report ? (
        <p className="mt-3 text-[11px] text-white/40">Outcome calibration unavailable.</p>
      ) : report.totalCompleted === 0 ? (
        <p className="mt-3 text-[11px] text-white/40">
          {metrics
            ? `${metrics.awaitingOutcome} evaluations awaiting outcome — no closed trade is attributable to an AI review yet, so win rate and P&L are withheld rather than estimated.`
            : "No completed trades linked to an AI review yet."}
        </p>
      ) : (
        <>
          <p className="mt-2 font-mono text-[10px] text-white/45">
            {report.totalCompleted} completed · minimum sample {report.minSample}
          </p>
          <div className="mt-2">
            <Row b={report.overall} />
            {report.byVerdict.filter((b) => b.sample > 0).map((b) => (
              <Row key={b.key} b={b} />
            ))}
            {report.byBand.filter((b) => b.sample > 0).map((b) => (
              <Row key={`band-${b.key}`} b={b} />
            ))}
          </div>
          <p className="mt-2 font-mono text-[9px] text-white/30">
            {report.version} · completed trades only
          </p>
        </>
      )}
    </section>
  );
}
