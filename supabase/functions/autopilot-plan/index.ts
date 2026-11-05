import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { Annotation, END, START, StateGraph } from "npm:@langchain/langgraph@1.4.14";
import { supportsLivePlan } from "../_shared/live-plan-route-policy.ts";
import { evaluatePaperEvidence } from "./validation.ts";
import {
  hasLiveExecutionRows,
  readWorkflowPaperEvidence,
  type PaperEvidenceReader,
} from "../_shared/autopilot-paper-evidence.ts";

type RiskMode = "conservative" | "moderate" | "aggressive";
type VenueAssignment = { symbol: string; connectionId: string; walletConnectionId: string | null };
type Proposal = {
  setupBook?: "paper" | "live";
  name: string;
  goalId: string;
  goalLabel: string;
  strategyId: string;
  strategyName: string;
  authorizedCapital: number;
  lossLimit: number;
  targetDays: number;
  riskMode: RiskMode;
  status: "awaiting_approval";
  maxLossPercent: number;
  requiresPaperValidation: boolean;
  liveExecutionAllowed: false;
  scheduleEnabled: boolean;
  activeDays: number[];
  windowStart: string;
  windowEnd: string;
  timezone: string;
  maxDailyEntries: number;
  maxOpenPositions: number;
  connectionId: string;
  venueAssignments?: VenueAssignment[];
  symbols: string[];
  enabledTurtles: string[];
  marginPct: 5;
  rungCount: 5;
  incomeAllocationPct: number;
  leverage?: number;
};
const ALLOWED_SYMBOLS = new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"]);
const ALLOWED_TURTLES = new Set(["accumulator", "vanguard", "sniper", "hunter", "arbiter"]);
const TIER_TURTLES: Record<string, readonly string[]> = {
  free: ["accumulator"],
  ion: ["accumulator", "vanguard"],
  arc: ["accumulator", "vanguard", "sniper"],
  orb: ["accumulator", "vanguard", "sniper", "hunter", "arbiter"],
  zen: ["accumulator", "vanguard", "sniper", "hunter", "arbiter"],
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const out = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

const State = Annotation.Root({
  proposal: Annotation<Proposal>(),
  status: Annotation<"awaiting_approval" | "paper_validation">(),
});
const workflow = new StateGraph(State)
  .addNode("validate_approval", (state) => {
    const plan = state.proposal;
    const valid =
      plan.status === "awaiting_approval" &&
      plan.authorizedCapital > 0 &&
      plan.lossLimit > 0 &&
      plan.lossLimit <= plan.authorizedCapital &&
      plan.targetDays >= 1 &&
      plan.targetDays <= 3650 &&
      ["conservative", "moderate", "aggressive"].includes(plan.riskMode) &&
      ["paper", "live"].includes(plan.setupBook ?? "paper") &&
      plan.requiresPaperValidation === (plan.setupBook !== "live") &&
      plan.liveExecutionAllowed === false &&
      ((plan.setupBook !== "live" && plan.leverage === undefined) ||
        (Number.isInteger(plan.leverage) && plan.leverage! >= 1 && plan.leverage! <= 125)) &&
      plan.name.trim().length >= 1 &&
      plan.name.trim().length <= 80 &&
      plan.activeDays.length >= 1 &&
      plan.activeDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
      /^\d{2}:\d{2}$/.test(plan.windowStart) &&
      /^\d{2}:\d{2}$/.test(plan.windowEnd) &&
      plan.timezone.trim().length >= 1 &&
      Number.isInteger(plan.maxDailyEntries) &&
      plan.maxDailyEntries >= 1 &&
      plan.maxDailyEntries <= 100 &&
      Number.isInteger(plan.maxOpenPositions) &&
      plan.maxOpenPositions >= 1 &&
      plan.maxOpenPositions <= 6 &&
      typeof plan.connectionId === "string" &&
      plan.connectionId.length > 0 &&
      (plan.venueAssignments === undefined ||
        (Array.isArray(plan.venueAssignments) &&
          plan.venueAssignments.length === plan.symbols.length &&
          new Set(plan.venueAssignments.map((assignment) => assignment.symbol)).size ===
            plan.symbols.length &&
          plan.venueAssignments.every(
            (assignment) =>
              plan.symbols.includes(assignment.symbol) &&
              typeof assignment.connectionId === "string" &&
              assignment.connectionId.length > 0 &&
              (assignment.walletConnectionId === null ||
                (typeof assignment.walletConnectionId === "string" &&
                  assignment.walletConnectionId.length > 0)),
          ))) &&
      plan.symbols.length >= 1 &&
      plan.symbols.length <= 4 &&
      plan.symbols.every((symbol) => ALLOWED_SYMBOLS.has(symbol)) &&
      new Set(plan.symbols).size === plan.symbols.length &&
      plan.enabledTurtles.length >= 1 &&
      plan.enabledTurtles.length <= 5 &&
      plan.enabledTurtles.every((turtle) => ALLOWED_TURTLES.has(turtle)) &&
      new Set(plan.enabledTurtles).size === plan.enabledTurtles.length &&
      plan.marginPct === 5 &&
      plan.rungCount === 5 &&
      plan.incomeAllocationPct === 100;
    if (!valid) throw new Error("The Autopilot proposal failed its safety validation.");
    return { status: "awaiting_approval" as const };
  })
  .addEdge(START, "validate_approval")
  .addEdge("validate_approval", END)
  .compile();

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return out(405, { ok: false, message: "POST required." });
  const url = Deno.env.get("SUPABASE_URL");
  const role = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !role) return out(500, { ok: false, message: "Autopilot service is unavailable." });
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const admin = createClient(url, role, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return out(401, { ok: false, message: "Sign in required." });
  try {
    const body = (await req.json()) as {
      action?: string;
      proposal?: Proposal;
      workflow_id?: string;
      expected_updated_at?: string;
      leverage?: number;
      max_daily_entries?: number;
      max_open_positions?: number;
    };
    if (body.action === "update_execution_settings") {
      if (typeof body.workflow_id !== "string" || typeof body.expected_updated_at !== "string" ||
          !Number.isInteger(body.leverage) || !Number.isInteger(body.max_daily_entries) || !Number.isInteger(body.max_open_positions))
        return out(400,{ok:false,message:"Choose explicit whole-number execution settings."});
      const {error} = await admin.rpc("update_autopilot_execution_settings", {
        _actor_id:auth.user.id,_workflow_id:body.workflow_id,_expected_updated_at:body.expected_updated_at,
        _leverage:body.leverage,_max_daily_entries:body.max_daily_entries,_max_open_positions:body.max_open_positions,
      });
      if (error) return out(409,{ok:false,message:error.message});
      return out(200,{ok:true});
    }
    if (["pause", "resume_paper", "archive"].includes(body.action ?? "")) {
      const workflowId = String(body.workflow_id ?? "");
      const { data: plan, error: planError } = await admin
        .from("autopilot_workflows")
        .select("id,status,authorized_capital,proposal")
        .eq("id", workflowId)
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (planError || !plan) return out(404, { ok: false, message: "Autopilot plan not found." });

      const savedProposal =
        plan.proposal && typeof plan.proposal === "object" && !Array.isArray(plan.proposal)
          ? (plan.proposal as Record<string, unknown>)
          : {};
      const { data: linkedRows, error: rowsError } = await admin
        .from("user_strategy")
        .select("mode")
        .eq("user_id", auth.user.id)
        .eq("params->>autopilot_workflow_id", workflowId);
      if (rowsError)
        return out(503, { ok: false, message: "Could not verify this plan's execution book." });
      const isLivePlan = hasLiveExecutionRows(savedProposal, linkedRows ?? []);
      if (body.action === "resume_paper" && isLivePlan)
        return out(409, { ok: false, message: "A live mandate cannot resume in simulation mode." });

      if (body.action === "resume_paper") {
        if (plan.status !== "paused")
          return out(409, { ok: false, message: "Only a paused plan can resume." });
      }

      const { data: result, error: controlError } = await admin.rpc("control_autopilot_plan", {
        _user_id: auth.user.id,
        _workflow_id: workflowId,
        _action: body.action,
        _expected_status: plan.status,
      });
      if (controlError)
        return out(409, {
          ok: false,
          message: "The plan could not be changed atomically. Refresh its status before retrying.",
        });
      return out(200, { ok: true, status: result.status });
    }
    if (body.action === "evaluate_paper") {
      const workflowId = String((body as { workflow_id?: string }).workflow_id ?? "");
      const { data: plan, error: planError } = await admin
        .from("autopilot_workflows")
        .select("id,user_id,strategy_id,authorized_capital,status,approved_at,proposal")
        .eq("id", workflowId)
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (planError || !plan) return out(404, { ok: false, message: "Autopilot plan not found." });
      if (!["paper_validation", "live_eligible"].includes(plan.status))
        return out(409, { ok: false, message: "This plan is not in paper validation." });
      if (!plan.approved_at)
        return out(409, { ok: false, message: "This plan has no approval timestamp." });
      const { data: linkedRows, error: rowsError } = await admin
        .from("user_strategy")
        .select("mode")
        .eq("user_id", auth.user.id)
        .eq("params->>autopilot_workflow_id", workflowId);
      if (rowsError)
        return out(503, { ok: false, message: "Could not verify this plan's execution book." });
      if (hasLiveExecutionRows(plan.proposal, linkedRows ?? []))
        return out(409, { ok: false, message: "Paper evidence cannot change a live mandate." });
      let trades;
      try {
        trades = await readWorkflowPaperEvidence(
          admin as unknown as PaperEvidenceReader,
          auth.user.id,
          workflowId,
          plan.approved_at,
        );
      } catch {
        return out(503, { ok: false, message: "Could not read attributed paper evidence." });
      }
      if (!trades.length)
        return out(409, {
          ok: false,
          message:
            "No closed paper trades are linked to this plan. Unattributed account trades cannot validate it.",
        });
      const { count: riskViolations, error: riskError } = await admin
        .from("autopilot_risk_events")
        .select("id", { count: "exact", head: true })
        .eq("workflow_id", workflowId)
        .eq("code", "loss_limit_reached")
        .eq("user_id", auth.user.id);
      if (riskError) return out(500, { ok: false, message: "Could not read risk evidence." });
      const { qualified, checks } = evaluatePaperEvidence(
        (trades ?? []).map((trade) => ({ realized_pnl: Number(trade.pnl_net) })),
        Number(plan.authorized_capital),
        riskViolations ?? 0,
      );
      const validation = {
        qualified,
        checks,
        evaluatedAt: new Date().toISOString(),
        note: "Eligibility starts a separate live review; it never enables live execution.",
      };
      const { data: validatedPlan, error: updateError } = await admin
        .from("autopilot_workflows")
        .update({
          status: qualified ? "live_eligible" : "paper_validation",
          validation,
          evaluated_at: validation.evaluatedAt,
          updated_at: validation.evaluatedAt,
        })
        .eq("id", workflowId)
        .eq("user_id", auth.user.id)
        .eq("status", plan.status)
        .select("id")
        .maybeSingle();
      if (updateError)
        return out(500, { ok: false, message: "Could not save the validation result." });
      if (!validatedPlan)
        return out(409, {
          ok: false,
          message: "Plan changed during validation. Refresh before trying again.",
        });
      return out(200, {
        ok: true,
        status: qualified ? "live_eligible" : "paper_validation",
        validation,
      });
    }
    if (!["approve_for_paper", "configure_live"].includes(body.action ?? "") || !body.proposal)
      return out(400, { ok: false, message: "Invalid workflow action." });
    const liveSetup = body.action === "configure_live";
    if ((body.proposal.setupBook === "live") !== liveSetup)
      return out(400, {
        ok: false,
        message: "The setup mode does not match the requested action.",
      });
    await workflow.invoke({ proposal: body.proposal, status: "awaiting_approval" });
    const venueAssignments =
      body.proposal.venueAssignments ??
      body.proposal.symbols.map((symbol) => ({
        symbol,
        connectionId: body.proposal!.connectionId,
        walletConnectionId: null,
      }));
    const proposal = {
      ...body.proposal,
      venueAssignments,
      // Independent paper routes coexist with the same venue/symbol's live row.
      ...(!liveSetup ? { setupBook: "paper" as const, paperRouteVersion: 1 } : {}),
      // Saving an approved setup is not arming it: live rows below remain disabled.
      status: liveSetup ? "live_configured" : "paper_validation",
      liveExecutionAllowed: false,
    };
    const connectionIds = [
      ...new Set(venueAssignments.map((assignment) => assignment.connectionId)),
    ];
    const { data: connections, error: connectionError } = await admin
      .from("exchange_connections")
      .select("id,exchange,environment,status,permissions_verified,permission_read,permission_trade")
      .eq("user_id", auth.user.id)
      .in("id", connectionIds);
    if (connectionError || (connections ?? []).length !== connectionIds.length) {
      return out(400, { ok: false, message: "Every selected venue must belong to this account." });
    }
    if (liveSetup && (connections ?? []).some((connection) => !supportsLivePlan(connection))) {
      return out(409, {ok:false,message:"Live plans require a supported mainnet venue with verified read and trade permission."});
    }
    if (
      proposal.leverage !== undefined &&
      (connections ?? []).some(
        (connection) => connection.exchange === "apex_omni" && proposal.leverage! > 100,
      )
    ) {
      return out(400, {
        ok: false,
        message:
          "ApeX plans support a leverage ceiling of 100×. Choose a compatible value for every selected venue.",
      });
    }
    if (
      (connections ?? []).some(
        (connection) =>
          connection.status !== "verified" ||
          !connection.permissions_verified ||
          !connection.permission_read,
      )
    ) {
      return out(409, {
        ok: false,
        message: "Every selected venue must be verified and readable.",
      });
    }
    const walletIds = [
      ...new Set(
        venueAssignments
          .map((assignment) => assignment.walletConnectionId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (walletIds.length) {
      const { data: wallets, error: walletsError } = await admin
        .from("wallet_connections")
        .select("id,status,is_active,assigned_exchange_connection_id")
        .eq("user_id", auth.user.id)
        .in("id", walletIds);
      if (walletsError || (wallets ?? []).length !== walletIds.length) {
        return out(400, {
          ok: false,
          message: "Every selected wallet must belong to this account.",
        });
      }
      const byId = new Map((wallets ?? []).map((wallet) => [wallet.id, wallet]));
      if (
        venueAssignments.some((assignment) => {
          if (!assignment.walletConnectionId) return false;
          const wallet = byId.get(assignment.walletConnectionId);
          return (
            !wallet ||
            !["connected", "verified"].includes(wallet.status) ||
            !wallet.is_active ||
            wallet.assigned_exchange_connection_id !== assignment.connectionId
          );
        })
      ) {
        return out(409, {
          ok: false,
          message: "A selected wallet is not active, verified, and assigned to its exchange.",
        });
      }
    }
    const [
      { data: subscription, error: subscriptionError },
      { data: adminRole, error: roleError },
    ] = await Promise.all([
      admin.from("subscriptions").select("tier").eq("user_id", auth.user.id).maybeSingle(),
      admin
        .from("user_roles")
        .select("role")
        .eq("user_id", auth.user.id)
        .eq("role", "admin")
        .maybeSingle(),
    ]);
    if (subscriptionError || roleError) {
      return out(500, { ok: false, message: "Could not verify Turtle access." });
    }
    // Paper comparison is available for every trading Turtle; live entitlements remain unchanged.
    const entitled =
      adminRole || !liveSetup
        ? ALLOWED_TURTLES
        : new Set(TIER_TURTLES[String(subscription?.tier ?? "free")] ?? TIER_TURTLES.free);
    const unavailable = proposal.enabledTurtles.filter((turtle) => !entitled.has(turtle));
    if (unavailable.length > 0) {
      return out(403, {
        ok: false,
        message: "This plan includes a Turtle not unlocked for the account.",
      });
    }
    // Only live configuration writes user_strategy. Paper route conflicts are
    // serialized by guard_paper_workflow_routes in the workflow transaction.
    const { data: occupied, error: occupiedError } = liveSetup
      ? await admin
          .from("user_strategy")
          .select("symbol,connection_id,enabled,mode,params")
          .eq("user_id", auth.user.id)
          .in("connection_id", connectionIds)
          .in("symbol", proposal.symbols)
      : { data: [], error: null };
    if (occupiedError)
      return out(500, { ok: false, message: "Could not verify symbol availability." });
    const conflicts = (occupied ?? []).filter((row) => {
      if (
        !venueAssignments.some(
          (assignment) =>
            assignment.symbol === row.symbol && assignment.connectionId === row.connection_id,
        )
      )
        return false;
      const params =
        row.params && typeof row.params === "object" && !Array.isArray(row.params)
          ? (row.params as Record<string, unknown>)
          : {};
      return row.enabled || row.mode === "live" || typeof params.autopilot_workflow_id === "string";
    });
    if (conflicts.length > 0) {
      return out(409, {
        ok: false,
        message: `Pause or archive the existing campaign for ${conflicts.map((row) => row.symbol).join(", ")} first.`,
      });
    }
    let goalLabel = "Grow trading balance";
    if (proposal.goalId !== "growth") {
      const { data: bill, error: billError } = await admin
        .from("bills")
        .select("name")
        .eq("id", proposal.goalId)
        .eq("user_id", auth.user.id)
        .is("archived_at", null)
        .maybeSingle();
      if (billError) return out(500, { ok: false, message: "Could not verify Life Map target." });
      if (!bill)
        return out(400, {
          ok: false,
          message: "Select an active Life Map bill or balance growth.",
        });
      goalLabel = bill.name;
    }
    const { data, error } = await admin
      .from("autopilot_workflows")
      .insert({
        user_id: auth.user.id,
        name: proposal.name,
        strategy_id: proposal.strategyId,
        goal_id: proposal.goalId,
        goal_label: goalLabel,
        authorized_capital: proposal.authorizedCapital,
        loss_limit: proposal.lossLimit,
        target_days: proposal.targetDays,
        risk_mode: proposal.riskMode,
        status: proposal.status,
        proposal,
        schedule_enabled: proposal.scheduleEnabled,
        active_days: proposal.activeDays,
        window_start: proposal.windowStart,
        window_end: proposal.windowEnd,
        timezone: proposal.timezone,
        max_daily_entries: proposal.maxDailyEntries,
        max_open_positions: proposal.maxOpenPositions,
        connection_id: venueAssignments[0].connectionId,
        symbols: proposal.symbols,
        enabled_turtles: proposal.enabledTurtles,
        margin_pct: proposal.marginPct,
        rung_count: proposal.rungCount,
        income_allocation_pct: proposal.incomeAllocationPct,
        approved_at: new Date().toISOString(),
      })
      .select("id,status")
      .single();
    if (error)
      return out(error.code === "23514" ? 409 : 500, {
        ok: false,
        message: error.message.includes("paper_route_overlap")
          ? "An active paper plan already uses this symbol and Turtle. Edit or pause that paper plan; live plans are unaffected."
          : "Could not save this plan. Check the paper capital, active-plan limits, and route assignments.",
      });
    if (!liveSetup) return out(200, { ok: true, workflow: data });
    const params = {
      automation_version: 2,
      autopilot_workflow_id: data.id,
      enabled_turtles: proposal.enabledTurtles,
      margin_pct: 5,
      rung_count: 5,
      dynamic_wallet_sizing: true,
      authorized_capital: proposal.authorizedCapital,
      loss_limit: proposal.lossLimit,
      max_daily_entries: proposal.maxDailyEntries,
      max_open_positions: proposal.maxOpenPositions,
      schedule_enabled: proposal.scheduleEnabled,
      active_days: proposal.activeDays,
      window_start: proposal.windowStart,
      window_end: proposal.windowEnd,
      timezone: proposal.timezone,
      income_allocation_pct: proposal.incomeAllocationPct,
      ...(proposal.leverage !== undefined ? { leverage: proposal.leverage } : {}),
    };
    const rows = venueAssignments.map((assignment) => ({
      user_id: auth.user.id,
      connection_id: assignment.connectionId,
      symbol: assignment.symbol,
      strategy_id: proposal.strategyId,
      market_type: "futures",
      cross_margin: true,
      enabled: !liveSetup,
      mode: liveSetup ? "live" : "paper",
      params: {
        ...params,
        symbol: assignment.symbol,
        wallet_connection_id: assignment.walletConnectionId,
      },
      hedge_guard: {},
      margin_mode: "cross",
      updated_at: new Date().toISOString(),
    }));
    const { error: rowsError } = await admin
      .from("user_strategy")
      .upsert(rows, { onConflict: "user_id,connection_id,symbol" });
    if (rowsError) {
      await admin
        .from("autopilot_workflows")
        .delete()
        .eq("id", data.id)
        .eq("user_id", auth.user.id);
      return out(500, { ok: false, message: "Could not create the execution rows for this plan." });
    }
    return out(200, { ok: true, workflow: data });
  } catch (error) {
    return out(400, {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid request.",
    });
  }
});
