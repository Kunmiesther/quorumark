/**
 * OnyxDecisionsPanel — Stage 1 observe-and-recommend view rendered inside
 * OnyxPanel. Advisory only: this component NEVER triggers execution and
 * NEVER writes state. It displays the Onyx brain's structured decisions,
 * the deterministic guardrails that were applied, and the rationale
 * emitted by the model.
 */
import { RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useOnyxDecisions } from "@/hooks/useOnyxDecisions";
import type { OnyxAction, OnyxDecision } from "@/lib/onyx/onyx.functions";

const EYEBROW = "font-mono text-[10px] uppercase tracking-[0.18em] text-white/40";

const ACTION_STYLE: Record<OnyxAction, { label: string; color: string; bg: string }> = {
  deploy: { label: "Deploy", color: "#2DD4BF", bg: "rgba(45,212,191,0.10)" },
  hold: { label: "Hold", color: "#FFB020", bg: "rgba(255,176,32,0.10)" },
  skip: { label: "Skip", color: "rgba(255,255,255,0.6)", bg: "rgba(255,255,255,0.05)" },
  bench: { label: "Bench", color: "#F87171", bg: "rgba(248,113,113,0.10)" },
};

export function OnyxDecisionsPanel({ compact = false }: { compact?: boolean }) {
  const { data, isLoading, isFetching, error, scoutLoading, scoutError, refresh } =
    useOnyxDecisions();

  return (
    <section
      aria-label="Onyx recommendations"
      className={compact ? "tb-neu-panel rounded-[24px] p-4" : undefined}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <p className={EYEBROW}>Onyx decisions</p>
        <span
          className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-widest"
          style={{ background: "rgba(45,212,191,0.10)", color: "#2DD4BF" }}
        >
          <ShieldCheck className="h-3 w-3" />
          Observing · advisory
        </span>
        <button
          type="button"
          onClick={() => refresh()}
          disabled={isFetching || scoutLoading}
          className="rounded-full p-1 text-white/60 transition hover:text-white disabled:opacity-40"
          aria-label="Refresh Onyx decisions"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="rounded-2xl bg-white/[0.04] p-4">
        {scoutError && <p className="text-xs text-red-300/80">Scout feed error: {scoutError}</p>}
        {(scoutLoading || (isLoading && !data)) && (
          <p className="text-[12.5px] text-white/55">Reading fleet + Scout intel…</p>
        )}
        {error && !data && <p className="text-xs text-red-300/80">{error}</p>}
        {data && <DecisionsBody data={data} compact={compact} />}
        <p className="mt-4 text-[10px] uppercase tracking-[0.22em] text-white/35">
          Stage 1 · recommendations only — Onyx does not execute
        </p>
      </div>
    </section>
  );
}

function DecisionsBody({
  data,
  compact,
}: {
  data: NonNullable<ReturnType<typeof useOnyxDecisions>["data"]>;
  compact: boolean;
}) {
  const deploys = data.decisions.filter((d) => d.action === "deploy");
  const others = data.decisions.filter((d) => d.action !== "deploy");

  return (
    <div className="space-y-4">
      {data.aiError && (
        <p className="rounded-lg bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
          {data.aiError}
        </p>
      )}

      {/* Fleet snapshot */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <FleetStat label="Wallets" value={String(data.fleet.walletCount)} />
        <FleetStat label="Open" value={String(data.fleet.openCount)} />
        <FleetStat label="Free" value={String(data.fleet.freeWalletCount)} />
        <FleetStat label="Benched" value={String(data.fleet.benchedWallets.length)} />
      </div>

      {/* Narrative */}
      {data.narrative && (
        <div className="rounded-xl bg-black/40 p-3">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" />
            <p className="text-[12.5px] leading-relaxed text-white/80">{data.narrative}</p>
          </div>
        </div>
      )}

      {/* Recommendations */}
      <div>
        <p className={`${EYEBROW} mb-2`}>Recommendations</p>
        {data.decisions.length === 0 ? (
          <p className="text-[12px] text-white/50">
            {data.options.length === 0
              ? "No opportunities cleared the guardrails this cycle."
              : "Model returned no decisions."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {[...deploys, ...others].slice(0, compact ? 3 : undefined).map((d, i) => (
              <DecisionRow key={i} d={d} />
            ))}
          </ul>
        )}
      </div>

      {/* Guardrail audit */}
      {!compact && data.filtered.length > 0 && (
        <div>
          <p className={`${EYEBROW} mb-2`}>Guardrails filtered</p>
          <ul className="space-y-1">
            {data.filtered.slice(0, 8).map((f, i) => (
              <li key={i} className="flex items-center gap-2 font-mono text-[11px] text-white/55">
                <span className="w-16 shrink-0 text-white/75">{f.base}</span>
                <span className="text-white/40">{f.reason}</span>
                <span className="ml-auto truncate text-right text-white/40">{f.detail}</span>
              </li>
            ))}
            {data.filtered.length > 8 && (
              <li className={`${EYEBROW}`}>+ {data.filtered.length - 8} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function DecisionRow({ d }: { d: OnyxDecision }) {
  const style = ACTION_STYLE[d.action];
  return (
    <li className="rounded-xl bg-black/40 p-2.5">
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest"
          style={{ background: style.bg, color: style.color }}
        >
          {style.label}
        </span>
        <span className="text-[12.5px] font-semibold text-white">{d.symbol}</span>
        {d.turtle && d.direction && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/50">
            {d.turtle} · {d.direction}
          </span>
        )}
        {d.walletKey && (
          <span className="ml-auto font-mono text-[10px] text-white/40">{d.walletKey}</span>
        )}
      </div>
      {d.rationale && <p className="mt-1 text-[12px] leading-snug text-white/65">{d.rationale}</p>}
    </li>
  );
}

function FleetStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-black/40 p-2">
      <p className="font-mono text-lg font-semibold tabular-nums text-white">{value}</p>
      <p className={EYEBROW}>{label}</p>
    </div>
  );
}
