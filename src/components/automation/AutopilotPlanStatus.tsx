import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Check,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

type ValidationCheck = {
  key: string;
  label: string;
  actual: string | number;
  required: string | number;
  passed: boolean;
};

const STATUS_COPY: Record<string, string> = {
  draft: "Draft",
  awaiting_approval: "Awaiting your approval",
  paper_validation: "Paper validation",
  live_eligible: "Eligible for live review",
  paused: "Paused",
  rejected: "Rejected",
};

export function AutopilotPlanStatus() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const planQ = useQuery({
    queryKey: ["autopilot-workflows", user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("autopilot_workflows")
        .select(
          "id, name, goal_label, risk_mode, status, authorized_capital, loss_limit, target_days, max_daily_entries, max_open_positions, validation, evaluated_at, updated_at, active_days, window_start, window_end, timezone, schedule_enabled, symbols, enabled_turtles, margin_pct, rung_count, income_allocation_pct, connection_id, proposal, exchange_connections(display_name,exchange)",
        )
        .eq("user_id", user!.id)
        .neq("status", "archived")
        .order("updated_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []).filter((plan) => {
        const proposal =
          plan.proposal && typeof plan.proposal === "object" && !Array.isArray(plan.proposal)
            ? (plan.proposal as Record<string, unknown>)
            : {};
        return proposal.setupBook !== "live";
      });
    },
  });

  if (planQ.isLoading)
    return (
      <div className="tb-neu-panel mt-5 grid h-24 place-items-center rounded-[28px]">
        <Loader2 className="h-5 w-5 animate-spin text-violet-300" />
      </div>
    );
  if (planQ.isError)
    return (
      <section className="tb-neu-panel mt-5 rounded-[28px] p-4 text-xs text-rose-200" role="alert">
        Saved plans could not be loaded. No configuration state is being inferred. Retry from the
        refresh control or reload this page before creating another plan.
      </section>
    );
  if (!planQ.data?.length)
    return (
      <section
        className="tb-neu-panel mt-5 rounded-[28px] p-4"
        aria-labelledby="start-plan-heading"
      >
        <p className="text-[10px] uppercase tracking-[0.18em] text-violet-300/75">Step 1 of 4</p>
        <h2 id="start-plan-heading" className="mt-1 font-display text-lg">
          Create an Autopilot plan
        </h2>
        <p className="mt-1 text-xs leading-5 text-white/45">
          Select a trading Turtle above and choose Build with Onyx. In that setup you can track a
          Life Map bill, choose a venue and symbols, set risk boundaries, and approve a paper plan.
          Bill allocation follows your Life Map priority, not the bill selected for tracking.
        </p>
        <Link
          to="/life-map"
          className="mt-3 inline-block text-xs text-violet-200 underline-offset-2 hover:underline"
        >
          Add or manage bills in Life Map
        </Link>
      </section>
    );
  async function runAction(
    action: "pause" | "resume_paper" | "archive",
    workflowId: string,
  ): Promise<void> {
    setPendingAction(`${action}:${workflowId}`);
    const { data, error } = await supabase.functions.invoke("autopilot-plan", {
      body: { action, workflow_id: workflowId },
    });
    setPendingAction(null);
    if (error || !data?.ok) {
      toast.error(data?.message ?? "Could not update this plan.");
      return;
    }
    toast.success(
      action === "pause"
        ? "Plan paused."
        : action === "archive"
          ? "Plan archived."
          : "Plan resumed in paper mode.",
    );
    await queryClient.invalidateQueries({ queryKey: ["autopilot-workflows", user?.id] });
  }

  async function evaluate(workflowId: string): Promise<void> {
    setPendingAction(`evaluate:${workflowId}`);
    const { data, error } = await supabase.functions.invoke("autopilot-plan", {
      body: { action: "evaluate_paper", workflow_id: workflowId },
    });
    setPendingAction(null);
    if (error || !data?.ok) {
      toast.error(data?.message ?? "Could not evaluate paper results.");
      return;
    }
    toast.success(
      data.status === "live_eligible"
        ? "Plan is eligible for live review."
        : "Paper validation progress updated.",
    );
    await queryClient.invalidateQueries({ queryKey: ["autopilot-workflows", user?.id] });
  }

  return (
    <section className="mt-5 space-y-3" aria-labelledby="active-plans-heading">
      <div className="flex items-end justify-between px-1">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-violet-300/75">
            Autopilot plans
          </p>
          <h2 id="active-plans-heading" className="mt-1 font-display text-lg">
            Your saved plans
          </h2>
        </div>
        <span className="text-xs text-white/40">{planQ.data.length} active mandates</span>
      </div>
      {planQ.data.map((plan: Plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          pendingAction={pendingAction}
          onEvaluate={evaluate}
          onAction={runAction}
        />
      ))}
    </section>
  );
}

type Plan = {
  id: string;
  name: string;
  goal_label: string;
  risk_mode: string;
  status: string;
  authorized_capital: number;
  loss_limit: number;
  target_days: number;
  max_daily_entries: number;
  max_open_positions: number;
  validation: unknown;
  active_days: number[];
  window_start: string;
  window_end: string;
  timezone: string;
  schedule_enabled: boolean;
  symbols: string[];
  enabled_turtles: string[];
  margin_pct: number;
  rung_count: number;
  income_allocation_pct: number;
  connection_id: string | null;
  proposal: unknown;
  exchange_connections: { display_name: string | null; exchange: string } | null;
};

function PlanCard({
  plan,
  pendingAction,
  onEvaluate,
  onAction,
}: {
  plan: Plan;
  pendingAction: string | null;
  onEvaluate: (id: string) => Promise<void>;
  onAction: (action: "pause" | "resume_paper" | "archive", id: string) => Promise<void>;
}) {
  const validation =
    plan.validation && typeof plan.validation === "object" && !Array.isArray(plan.validation)
      ? (plan.validation as { checks?: ValidationCheck[] })
      : null;
  const checks = Array.isArray(validation?.checks)
    ? validation.checks
    : [
        {
          key: "sample_size",
          label: "Closed paper trades",
          actual: 0,
          required: 30,
          passed: false,
        },
        { key: "net_pnl", label: "Net paper P&L", actual: "—", required: "> 0", passed: false },
        {
          key: "max_drawdown",
          label: "Maximum drawdown",
          actual: "—",
          required: "≤ 10%",
          passed: false,
        },
        { key: "risk_violations", label: "Risk violations", actual: 0, required: 0, passed: true },
      ];
  const proposal =
    plan.proposal && typeof plan.proposal === "object" && !Array.isArray(plan.proposal)
      ? (plan.proposal as Record<string, unknown>)
      : {};
  const assignments = Array.isArray(proposal.venueAssignments) ? proposal.venueAssignments : [];
  const assignedVenues = new Set(
    assignments.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const id = (entry as Record<string, unknown>).connectionId;
      return typeof id === "string" ? [id] : [];
    }),
  );

  return (
    <article className="tb-neu-panel rounded-[28px] p-4">
      <div className="flex items-start gap-3">
        <span className="tb-neu-raised grid h-11 w-11 shrink-0 place-items-center rounded-full text-emerald-300">
          <CheckCircle2 className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-300/75">
            {STATUS_COPY[plan.status] ?? plan.status}
          </p>
          <h3 className="mt-1 font-display text-lg">{plan.name}</h3>
          <p className="mt-0.5 text-xs text-white/40">{plan.goal_label}</p>
          <p className="mt-1 text-xs capitalize text-white/45">
            {plan.risk_mode} · ${Number(plan.authorized_capital).toLocaleString()} capital · $
            {Number(plan.loss_limit).toLocaleString()} pause limit · {plan.target_days} days
          </p>
        </div>
      </div>
      <p className="mt-3 text-[11px] text-white/45">
        {plan.schedule_enabled
          ? `${plan.active_days.length} days · ${plan.window_start.slice(0, 5)}–${plan.window_end.slice(0, 5)} · ${plan.timezone}`
          : "Schedule off"}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] font-semibold uppercase tracking-[0.12em]">
        <span className="rounded-full border border-cyan-300/20 bg-cyan-300/[0.06] px-2 py-1 text-cyan-200">
          {assignedVenues.size > 1
            ? `${assignedVenues.size} venues`
            : plan.exchange_connections?.display_name ||
              plan.exchange_connections?.exchange ||
              "Venue unavailable"}
        </span>
        {plan.symbols.map((symbol) => (
          <span
            key={symbol}
            className="rounded-full border border-white/10 px-2 py-1 text-white/55"
          >
            {symbol.replace("-USDT", "")}
          </span>
        ))}
        <span className="rounded-full border border-violet-300/20 bg-violet-300/[0.06] px-2 py-1 text-violet-200">
          {plan.enabled_turtles.length} Turtles
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px] tabular-nums">
        <div className="tb-neu-inset rounded-xl px-3 py-2 text-white/55">
          <span className="block text-[8.5px] uppercase tracking-[0.12em] text-white/30">
            Daily entry cap
          </span>
          <span className="mt-0.5 block text-white">{plan.max_daily_entries}</span>
        </div>
        <div className="tb-neu-inset rounded-xl px-3 py-2 text-white/55">
          <span className="block text-[8.5px] uppercase tracking-[0.12em] text-white/30">
            Open position cap
          </span>
          <span className="mt-0.5 block text-white">{plan.max_open_positions}</span>
        </div>
        <div className="tb-neu-inset rounded-xl px-3 py-2 text-white/55">
          <span className="block text-[8.5px] uppercase tracking-[0.12em] text-white/30">
            Dynamic sizing
          </span>
          <span className="mt-0.5 block text-white">
            {plan.margin_pct}% · {plan.rung_count} rungs
          </span>
        </div>
        <div className="tb-neu-inset rounded-xl px-3 py-2 text-white/55">
          <span className="block text-[8.5px] uppercase tracking-[0.12em] text-white/30">
            Life Map tracking
          </span>
          <span className="mt-0.5 block text-white">
            {plan.income_allocation_pct}% of positive net P&amp;L
          </span>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-2xl bg-emerald-400/[0.05] p-3 text-[11px] text-white/50">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-300" />
        The owner can keep this plan in Paper or arm its saved strategy rows for Live from the
        Operations Monitor.
      </div>
      <div className="mt-3 grid gap-2">
        {checks.map((check) => (
          <div
            key={check.key}
            className="tb-neu-inset flex items-center gap-2 rounded-xl px-3 py-2 text-[11px]"
          >
            <span
              className={`grid h-5 w-5 place-items-center rounded-full ${check.passed ? "text-emerald-300" : "text-white/30"}`}
            >
              {check.passed ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
            </span>
            <span className="flex-1 text-white/60">{check.label}</span>
            <span className="font-mono text-white/75">
              {String(check.actual)} / {String(check.required)}
            </span>
          </div>
        ))}
      </div>
      <Button
        type="button"
        onClick={() => void onEvaluate(plan.id)}
        disabled={pendingAction !== null || plan.status === "paused"}
        className="mt-4 h-11 w-full rounded-2xl"
        variant="outline"
      >
        {pendingAction === `evaluate:${plan.id}` ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="mr-2 h-4 w-4" />
        )}
        Check paper progress
      </Button>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pendingAction !== null}
          onClick={() =>
            void onAction(plan.status === "paused" ? "resume_paper" : "pause", plan.id)
          }
        >
          {plan.status === "paused" ? (
            <Play className="mr-2 h-4 w-4" />
          ) : (
            <Pause className="mr-2 h-4 w-4" />
          )}
          {plan.status === "paused" ? "Resume" : "Pause"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pendingAction !== null}
          onClick={() => void onAction("archive", plan.id)}
        >
          <Archive className="mr-2 h-4 w-4" /> Archive
        </Button>
      </div>
    </article>
  );
}
