import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaperPlanRoute } from "./paperAuthorization";
import {
  isIndependentPaperPlan,
  paperWorkflowRoutes,
} from "../../../supabase/functions/_shared/paper-workflow-routes";
import {
  hasLiveExecutionRows,
  readWorkflowPaperEvidence,
  type PaperEvidenceReader,
} from "../../../supabase/functions/_shared/autopilot-paper-evidence";

export type AutopilotSchedule = {
  active_days: number[];
  window_start: string;
  window_end: string;
  timezone: string;
  schedule_enabled: boolean;
};

function localParts(now: Date, timezone: string): { day: number; time: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value("weekday"));
    if (day < 0) return null;
    return { day, time: `${value("hour")}:${value("minute")}:${value("second")}` };
  } catch {
    return null;
  }
}

export function isAutopilotScheduleOpen(plan: AutopilotSchedule, now = new Date()): boolean {
  if (!plan.schedule_enabled) return false;
  const local = localParts(now, plan.timezone);
  if (!local || !plan.active_days.includes(local.day)) return false;
  const start = plan.window_start.slice(0, 8);
  const end = plan.window_end.slice(0, 8);
  if (start <= end) return local.time >= start && local.time <= end;
  return local.time >= start || local.time <= end;
}

export function hasAutopilotLossLimitBreached(
  realizedPnls: Array<number | string>,
  lossLimit: number,
): boolean {
  const realized = realizedPnls.reduce<number>((sum, pnl) => {
    const value = Number(pnl);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  return Number.isFinite(lossLimit) && lossLimit > 0 && realized <= -lossLimit;
}

type RuntimeResult = {
  routes?: PaperPlanRoute[];
  controlled: boolean;
  shouldRun: boolean;
  reason: "legacy" | "scheduled" | "paused_or_outside_schedule" | "lookup_failed";
};

/**
 * Connects Autopilot's user-owned schedule and pause controls to the existing
 * deterministic paper worker. It never opens or manages a position itself.
 */
export async function evaluateAutopilotPaperRuntime(
  admin: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<RuntimeResult> {
  const { data, error } = await admin
    .from("autopilot_workflows")
    .select(
      "id,status,proposal,enabled_turtles,approved_at,loss_limit,schedule_enabled,active_days,window_start,window_end,timezone",
    )
    .eq("user_id", userId);

  if (error) return { controlled: true, shouldRun: false, reason: "lookup_failed" };
  if (!data?.length) return { controlled: false, shouldRun: true, reason: "legacy" };

  const { data: rows, error: rowsError } = await admin
    .from("user_strategy")
    .select("connection_id,symbol,enabled,mode,params")
    .eq("user_id", userId);
  if (rowsError) return { controlled: true, shouldRun: false, reason: "lookup_failed" };

  let shouldRun = false;
  const routes: PaperPlanRoute[] = [];
  for (const plan of data) {
    const linked = (rows ?? []).filter((row) => row.params?.autopilot_workflow_id === plan.id);
    if (hasLiveExecutionRows(plan.proposal, linked)) continue;
    if (!["paper_validation", "live_eligible"].includes(String(plan.status))) continue;
    if (!plan.approved_at) continue;

    let trades;
    try {
      trades = await readWorkflowPaperEvidence(
        admin as unknown as PaperEvidenceReader,
        userId,
        plan.id,
        String(plan.approved_at),
      );
    } catch {
      return { controlled: true, shouldRun: false, reason: "lookup_failed" };
    }

    const realizedPnls = (trades ?? []).map((trade) => trade.pnl_net as number | string);
    if (hasAutopilotLossLimitBreached(realizedPnls, Number(plan.loss_limit))) {
      const { error: pauseError } = await admin.rpc("control_autopilot_plan", {
        _user_id: userId,
        _workflow_id: plan.id,
        _action: "paper_loss_pause",
        _expected_status: plan.status,
      });
      if (pauseError) return { controlled: true, shouldRun: false, reason: "lookup_failed" };
      continue;
    }

    if (
      isAutopilotScheduleOpen(
        {
          schedule_enabled: Boolean(plan.schedule_enabled),
          active_days: Array.isArray(plan.active_days) ? plan.active_days.map(Number) : [],
          window_start: String(plan.window_start),
          window_end: String(plan.window_end),
          timezone: String(plan.timezone),
        },
        now,
      )
    ) {
      shouldRun = true;
      if (isIndependentPaperPlan(plan.proposal)) {
        const ownedRoutes = paperWorkflowRoutes(plan);
        if (!ownedRoutes.length)
          return { controlled: true, shouldRun: false, reason: "lookup_failed" };
        routes.push(...ownedRoutes);
        continue;
      }
      for (const row of linked) {
        if (row.mode !== "paper" || row.enabled !== true) continue;
        const turtles = row.params?.enabled_turtles;
        if (!Array.isArray(turtles) || !row.connection_id) continue;
        routes.push({
          workflowId: plan.id,
          connectionId: row.connection_id,
          symbol: row.symbol,
          turtles: turtles.filter((turtle): turtle is string => typeof turtle === "string"),
        });
      }
    }
  }

  return {
    controlled: true,
    routes,
    shouldRun,
    reason: shouldRun ? "scheduled" : "paused_or_outside_schedule",
  };
}
