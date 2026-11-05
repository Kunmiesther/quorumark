import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

type ProofDecision = {
  decision_id: string;
  symbol: string;
  strategy: string;
  timeframe: string;
  candle_close_at: string;
  direction: string;
  reason: string;
  reason_code: string;
  evidence: Json;
  evidence_hash: string;
  execution_state: string;
  safety_checks: Json | null;
};

type CouncilOpinion = {
  role: string;
  provider: string;
  model: string;
  status: string;
  direction: string | null;
  confidence: number | null;
  summary: string | null;
  risk_flags: string[];
};

function objectValue(value: Json | null): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function textValue(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readDecisionContext(evidence: Json) {
  const root = objectValue(evidence);
  const timeframes = objectValue(
    root.timeframes ?? root.setup_timeframes ?? root.higher_timeframes ?? null,
  );
  return {
    regime: textValue(root.regime ?? root.market_regime) ?? "Not recorded",
    oneHour: timeframes["1h"] != null || root["1h"] != null,
    fourHour: timeframes["4h"] != null || root["4h"] != null,
  };
}

function statusTone(ok: boolean) {
  return ok ? "text-[color:var(--onixus-teal)]" : "text-amber-300";
}

function readErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown database read error";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 220);
}

export function DecisionProofPanel() {
  const { user } = useAuth();
  const decision = useQuery({
    queryKey: ["decision-proof", user?.id],
    enabled: Boolean(user?.id),
    refetchInterval: 15_000,
    queryFn: async (): Promise<ProofDecision | null> => {
      const { data, error } = await supabase
        .from("strategy_decisions")
        .select(
          "decision_id,symbol,strategy,timeframe,candle_close_at,direction,reason,reason_code,evidence,evidence_hash,execution_state,safety_checks",
        )
        .eq("user_id", user!.id)
        .order("candle_close_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as ProofDecision | null;
    },
  });

  const opinions = useQuery({
    queryKey: ["decision-proof-opinions", decision.data?.decision_id],
    enabled: Boolean(decision.data?.decision_id),
    queryFn: async (): Promise<CouncilOpinion[]> => {
      const { data, error } = await supabase
        .from("ai_decision_opinions")
        .select("role,provider,model,status,direction,confidence,summary,risk_flags")
        .eq("decision_id", decision.data!.decision_id)
        .order("role");
      if (error) throw error;
      return (data ?? []) as CouncilOpinion[];
    },
  });

  if (decision.isLoading) return <p className="text-xs text-white/45">Loading decision proof…</p>;
  if (decision.error)
    return (
      <div className="rounded-xl border border-rose-300/25 bg-rose-300/[0.06] p-3 text-xs text-rose-200">
        <p className="font-semibold">Decision proof is unavailable.</p>
        <p className="mt-1 break-words font-mono text-[9px] text-rose-200/70">
          {readErrorMessage(decision.error)}
        </p>
        <button
          type="button"
          onClick={() => void decision.refetch()}
          className="mt-2 rounded-lg border border-rose-200/25 px-2 py-1 text-[10px] font-semibold hover:bg-white/[0.04]"
        >
          Retry read
        </button>
      </div>
    );
  if (!decision.data) {
    return (
      <p className="text-xs leading-5 text-white/45">
        No decision has been recorded yet. Every completed 15-minute evaluation—including WAIT—will
        appear here.
      </p>
    );
  }

  const row = decision.data;
  const context = readDecisionContext(row.evidence);
  const executionAt15m = row.timeframe === "15m";
  const safetyRecorded = Object.keys(objectValue(row.safety_checks)).length > 0;

  return (
    <div className="space-y-3" data-testid="decision-proof-panel">
      <div className="grid gap-2 sm:grid-cols-4">
        {[
          ["Execution", row.timeframe, executionAt15m],
          ["1-hour setup", context.oneHour ? "Recorded" : "Missing", context.oneHour],
          ["4-hour setup", context.fourHour ? "Recorded" : "Missing", context.fourHour],
          ["Safety gate", safetyRecorded ? "Recorded" : "Not reached", safetyRecorded],
        ].map(([label, value, ok]) => (
          <div
            key={String(label)}
            className="rounded-xl bg-[color:var(--surface-2)] p-3 shadow-[inset_2px_2px_5px_rgba(0,0,0,.45),inset_-1px_-1px_3px_rgba(255,255,255,.035)]"
          >
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">
              {String(label)}
            </p>
            <p className={`mt-1 text-xs font-semibold ${statusTone(Boolean(ok))}`}>
              {String(value)}
            </p>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-[color:var(--surface-2)] p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[color:var(--onixus-purple)]" />
          <p className="text-xs font-semibold text-white">
            {row.symbol} · {row.direction.toUpperCase()} · {row.execution_state}
          </p>
        </div>
        <p className="mt-2 text-xs leading-5 text-white/60">{row.reason || row.reason_code}</p>
        <p className="mt-2 font-mono text-[9px] text-white/35">
          {row.strategy} · regime {context.regime} ·{" "}
          {new Date(row.candle_close_at).toLocaleString()}
        </p>
        <p className="mt-1 truncate font-mono text-[9px] text-white/25" title={row.evidence_hash}>
          Evidence {row.evidence_hash}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">
          AI Council · advisory only
        </p>
        {opinions.isLoading ? (
          <p className="text-xs text-white/40">Loading Council opinions…</p>
        ) : null}
        {opinions.isError ? (
          <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-[10px] text-amber-200">
            Council opinions could not be read: {readErrorMessage(opinions.error)}
            <button
              type="button"
              onClick={() => void opinions.refetch()}
              className="ml-2 underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        ) : null}
        {!opinions.isLoading && !opinions.isError && (opinions.data?.length ?? 0) === 0 ? (
          <p className="text-xs text-white/40">
            No Council opinion was attached to this deterministic decision.
          </p>
        ) : null}
        {opinions.data?.map((opinion) => (
          <div
            key={`${opinion.role}-${opinion.provider}-${opinion.model}`}
            className="rounded-xl bg-[color:var(--surface-2)] px-3 py-2 text-xs"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold capitalize text-white">{opinion.role}</span>
              <span className="font-mono text-[9px] text-white/40">
                {opinion.status === "evaluated"
                  ? `${opinion.direction ?? "wait"} · ${Math.round((opinion.confidence ?? 0) * 100)}%`
                  : "unavailable"}
              </span>
            </div>
            <p className="mt-1 text-white/55">{opinion.summary ?? "No additional explanation."}</p>
            {opinion.risk_flags.length ? (
              <p className="mt-1 text-[10px] text-amber-300">
                Risk flags: {opinion.risk_flags.join(", ")}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
