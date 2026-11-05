import { createServerFn } from "@tanstack/react-start";
import { resolveGlmTransport, glmGenerationOptions } from "@/lib/ai/glmTransport.server";
import { recordRawAiUsage } from "@/lib/ai/usage.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export type SetupStep = {
  key: "exchange" | "strategy" | "risk" | "practice" | "goal";
  label: string;
  detail: string;
  complete: boolean;
  required: boolean;
  to: "/exchanges" | "/home" | "/profile" | "/trade" | "/life-map";
};

export type OnyxSetupGuide = {
  displayName: string;
  readyToTrade: boolean;
  completeCount: number;
  requiredCount: number;
  stats: {
    connectedVenues: number;
    paperTrades: number;
    openPositions: number;
  };
  steps: SetupStep[];
  summary: string;
  nextStep: SetupStep | null;
};

async function readGuide(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<OnyxSetupGuide> {
  const [
    profileResult,
    connectionResult,
    strategyResult,
    tradeResult,
    workflowResult,
    billResult,
    positionResult,
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("display_name, risk_acknowledged")
      .eq("id", userId)
      .maybeSingle(),
    supabase
      .from("exchange_connections")
      .select(
        "exchange, status, permission_read, permission_trade, permissions_verified, withdrawals_disabled",
      )
      .eq("user_id", userId)
      .neq("status", "disconnected"),
    supabase
      .from("user_strategy")
      .select("enabled")
      .eq("user_id", userId)
      .eq("enabled", true)
      .limit(1),
    supabase
      .from("paper_trades")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    supabase
      .from("autopilot_workflows")
      .select("status, goal_label")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("bills")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("archived_at", null),
    supabase
      .from("positions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "open"),
  ]);

  const profile = profileResult.data;
  const connections = connectionResult.data ?? [];
  const verifiedConnection = connections.find(
    (connection: {
      status: string;
      permission_read: boolean;
      permissions_verified: boolean;
      withdrawals_disabled: boolean;
    }) =>
      connection.status === "verified" &&
      connection.permission_read &&
      connection.permissions_verified &&
      connection.withdrawals_disabled,
  );
  const tradeConnection = connections.find(
    (connection: { status: string; permission_trade: boolean; permissions_verified: boolean }) =>
      connection.status === "verified" &&
      connection.permission_trade &&
      connection.permissions_verified,
  );
  const hasStrategy = (strategyResult.data?.length ?? 0) > 0;
  const paperTrades = tradeResult.count ?? 0;
  const workflow = workflowResult.data;
  const billCount = billResult.count ?? 0;

  const steps: SetupStep[] = [
    {
      key: "exchange",
      label: "Connect a trading-enabled exchange",
      detail: tradeConnection
        ? `${tradeConnection.exchange} is verified for trading.`
        : verifiedConnection
          ? `${verifiedConnection.exchange} is connected read-only. Add trading permission when you are ready.`
          : "Connect Coinbase or Kraken and verify its permissions. Withdrawals must remain disabled.",
      complete: Boolean(tradeConnection),
      required: true,
      to: "/exchanges",
    },
    {
      key: "strategy",
      label: "Choose a Turtle strategy",
      detail: hasStrategy
        ? "Your active strategy is selected."
        : "Choose the strategy that defines entries, exits, and risk rules.",
      complete: hasStrategy,
      required: true,
      to: "/home",
    },
    {
      key: "risk",
      label: "Accept the risk controls",
      detail: profile?.risk_acknowledged
        ? "Your risk disclosure is acknowledged."
        : "Review the non-custodial controls and acknowledge trading risk.",
      complete: Boolean(profile?.risk_acknowledged),
      required: true,
      to: "/profile",
    },
    {
      key: "practice",
      label: "Build paper-trading evidence",
      detail:
        paperTrades > 0
          ? `${paperTrades} paper trade${paperTrades === 1 ? "" : "s"} recorded. Autopilot reviews at 30.`
          : "Run Paper mode first. Autopilot requires evidence before live review.",
      complete: paperTrades >= 30,
      required: false,
      to: "/trade",
    },
    {
      key: "goal",
      label: "Connect a real-life goal",
      detail: workflow
        ? `${workflow.goal_label} is linked to an Autopilot plan.`
        : billCount > 0
          ? "Your Life Map is started; create an Autopilot plan when ready."
          : "Add a bill or target so Onyx can explain what the plan is protecting.",
      complete: Boolean(workflow),
      required: false,
      to: "/life-map",
    },
  ];
  const requiredSteps = steps.filter((step) => step.required);
  const nextStep = steps.find((step) => step.required && !step.complete) ?? null;
  const readyToTrade = requiredSteps.every((step) => step.complete);

  return {
    displayName: profile?.display_name?.trim() || "there",
    readyToTrade,
    completeCount: requiredSteps.filter((step) => step.complete).length,
    requiredCount: requiredSteps.length,
    stats: {
      connectedVenues: connections.filter(
        (connection: { status: string }) => connection.status === "verified",
      ).length,
      paperTrades,
      openPositions: positionResult.count ?? 0,
    },
    steps,
    nextStep,
    summary: readyToTrade
      ? "Your required controls are complete. You can review a trade, while Autopilot remains separately gated by paper evidence."
      : nextStep
        ? `You are ${requiredSteps.filter((step) => step.complete).length} of ${requiredSteps.length} required steps complete. Next: ${nextStep.label}.`
        : "Your current setup status is available below.",
  };
}

export const getOnyxSetupGuide = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => readGuide(context.supabase, context.userId));

const askSchema = z.object({
  question: z.string().trim().min(2).max(500),
  context: z.enum(["general", "automation"]).optional(),
});

async function readAutomationContext(supabase: SupabaseClient<Database>, userId: string) {
  const [venues, wallets, plans, rows, bills] = await Promise.all([
    supabase
      .from("exchange_connections")
      .select("id,exchange,status,permission_trade,permissions_verified")
      .eq("user_id", userId),
    supabase
      .from("wallet_connections")
      .select("id,label,status,is_active,assigned_exchange_connection_id")
      .eq("user_id", userId),
    supabase
      .from("autopilot_workflows")
      .select("id,name,status,goal_label,symbols,enabled_turtles")
      .eq("user_id", userId)
      .neq("status", "archived")
      .order("updated_at", { ascending: false })
      .limit(10),
    supabase
      .from("user_strategy")
      .select("connection_id,symbol,enabled,mode,params")
      .eq("user_id", userId),
    supabase.from("bills").select("id,name").eq("user_id", userId).is("archived_at", null),
  ]);
  const error = venues.error ?? wallets.error ?? plans.error ?? rows.error ?? bills.error;
  if (error) throw error;
  return {
    verifiedTradeVenues: (venues.data ?? [])
      .filter(
        (venue) =>
          venue.status === "verified" && venue.permission_trade && venue.permissions_verified,
      )
      .map((venue) => ({ id: venue.id, exchange: venue.exchange })),
    activeWallets: (wallets.data ?? [])
      .filter((wallet) => wallet.is_active && ["connected", "verified"].includes(wallet.status))
      .map((wallet) => ({
        id: wallet.id,
        label: wallet.label,
        venueId: wallet.assigned_exchange_connection_id,
      })),
    plans: plans.data ?? [],
    liveRows: (rows.data ?? [])
      .filter((row) => row.enabled && row.mode === "live")
      .map((row) => ({ venueId: row.connection_id, symbol: row.symbol })),
    activeBills: bills.data ?? [],
  };
}

function automationFallback(
  state: Awaited<ReturnType<typeof readAutomationContext>>,
  question: string,
): string {
  const request = question.toLowerCase();
  if (/wallet|exchange|venue/.test(request))
    return `You have ${state.verifiedTradeVenues.length} verified trading venue connection${state.verifiedTradeVenues.length === 1 ? "" : "s"} and ${state.activeWallets.length} active wallet${state.activeWallets.length === 1 ? "" : "s"}. Open Exchanges to assign each wallet to its venue, then choose a venue for each symbol in the Live mandate builder. A saved wallet label does not prove its signer can route orders; check the venue's live readiness before arming.`;
  if (/life map|bill|goal|income/.test(request))
    return `You have ${state.activeBills.length} active Life Map target${state.activeBills.length === 1 ? "" : "s"}. In the mandate builder, choose one to track alongside confirmed net P&L. Linking a goal never transfers funds or pays a bill. Open Life Map to adjust the target first if needed.`;
  if (/result|win|profit|loss|decision/.test(request))
    return "Use Automation results below for recorded closes, win rate, P&L and the decision timeline. Live account totals can include manual trades; Turtle-level rates appear only when the fill carries a strategy ID. Select an exchange in the decision filter to inspect its recorded decisions.";
  if (state.verifiedTradeVenues.length === 0)
    return "Step 1: connect and verify a trading-enabled exchange in Exchanges. Then return here to map each symbol to a venue and, where required, its assigned wallet. I have not enabled trading.";
  if (state.plans.length === 0)
    return "Step 2: choose Build with Onyx below. Select the Turtles and symbols, map each symbol to a verified exchange and its wallet, link an optional Life Map bill, then review sizing, limits, schedule, and exits. The plan will not place an order without a separate live approval.";
  if (state.liveRows.length === 0)
    return "Your automation plan is saved, but no live strategy row is armed. Review the saved mandate and execution readiness in the Live operations section before approving live operation. A saved plan is not proof that trading has started.";
  return `I can see ${state.liveRows.length} armed live symbol ${state.liveRows.length === 1 ? "row" : "rows"} across your venues. Check the live decision stream and venue-confirmed fills below; armed rows alone do not prove orders are reaching an exchange.`;
}

const MARKET_SETUP_PATTERNS = [
  /\b(best|top|strongest|good|available)\b.*\b(setup|trade|pick|opportunit)/,
  /\b(find|show|scan)\b.*\b(setup|trade|market|opportunit)/,
  /\bwhat\s+(should|could|can)\s+i\s+trade\b/,
];

export function isMarketSetupQuestion(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  return MARKET_SETUP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function formatPrice(value: unknown): string | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number.toLocaleString(undefined, {
    maximumFractionDigits: number >= 1_000 ? 2 : number >= 1 ? 4 : 8,
  });
}

function readableScanReason(reason: unknown): string {
  const labels: Record<string, string> = {
    below_selection_threshold: "the available candidates did not clear the quality threshold",
    no_candidate_passed_review: "none of the candidates passed the Council review",
    no_qualified_candidates:
      "no candidate passed the liquidity, spread, volatility, and capacity filters",
    no_valid_entry_geometry: "no candidate had a safe entry, invalidation, and target structure",
    risk_guardian_veto_all: "the Risk Guardian rejected every candidate",
    universe_unavailable: "the market feed was unavailable",
  };
  const key = typeof reason === "string" ? reason : "";
  return labels[key] ?? "no candidate passed every required gate";
}

async function answerMarketSetupQuestion(userId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { runCommitteeCycle } = await import("@/lib/ai/committee/cycle.server");

  await runCommitteeCycle(supabaseAdmin, userId, { book: "paper" });

  const { data: cycle, error: cycleError } = await supabaseAdmin
    .from("committee_cycles")
    .select(
      "id, status, universe_size, candidate_count, reviewed_count, selected_symbol, selected_direction, selected_score, no_trade_reason, candle_close_at",
    )
    .eq("user_id", userId)
    .eq("book", "paper")
    .order("candle_close_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cycleError || !cycle) {
    return "I could not complete the market scan right now. I did not change your account or place an order. Please try again shortly.";
  }

  if (cycle.status !== "selected" || !cycle.selected_symbol) {
    return `I scanned ${cycle.universe_size ?? 0} liquid markets and reviewed ${cycle.reviewed_count ?? 0} Council candidate${cycle.reviewed_count === 1 ? "" : "s"}. There is no qualified setup right now because ${readableScanReason(cycle.no_trade_reason)}. The safer action is to wait; no order was placed.`;
  }

  const { data: selected } = await supabaseAdmin
    .from("committee_shortlist")
    .select("entry_plan, consensus_confidence, available_seats")
    .eq("cycle_id", cycle.id)
    .eq("state", "selected")
    .eq("symbol", cycle.selected_symbol)
    .maybeSingle();

  const plan =
    selected?.entry_plan &&
    typeof selected.entry_plan === "object" &&
    !Array.isArray(selected.entry_plan)
      ? (selected.entry_plan as Record<string, unknown>)
      : {};
  const entry = formatPrice(plan.entry);
  const stop = formatPrice(plan.stop);
  const targets = Array.isArray(plan.tpLevels)
    ? plan.tpLevels.map(formatPrice).filter((value): value is string => Boolean(value))
    : [];
  const confidence =
    selected?.consensus_confidence != null
      ? `${Math.round(selected.consensus_confidence * 100)}% Council confidence`
      : `${selected?.available_seats ?? 0} Council seats responded`;
  const pricePlan = [
    entry ? `Entry ${entry}` : null,
    stop ? `invalidation ${stop}` : null,
    targets.length > 0 ? `targets ${targets.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `Best qualified setup: **${cycle.selected_symbol} ${String(cycle.selected_direction ?? "").toUpperCase()}** on the 15-minute execution view. ${pricePlan || "The price plan is still being finalized."} · ${confidence}. It ranked first after liquidity, market structure, momentum, costs, capacity, and risk review. This is a paper-trade proposal—not an order. Review it before taking any action.`;
}

function fallbackAnswer(question: string, guide: OnyxSetupGuide): string {
  const lower = question.toLowerCase();
  if (lower.includes("live") || lower.includes("trade")) return guide.summary;
  if (lower.includes("practice") || lower.includes("paper")) {
    const practice = guide.steps.find((step) => step.key === "practice");
    return `${practice?.detail ?? "Use Paper mode before Live mode."} Paper trading uses simulated funds and does not place a live order.`;
  }
  if (lower.includes("goal") || lower.includes("bill") || lower.includes("autom")) {
    const goal = guide.steps.find((step) => step.key === "goal");
    return `${goal?.detail ?? "Open Life Map to add a goal."} Goals inform planning; they never give Onyx permission to move money.`;
  }
  return guide.nextStep
    ? `${guide.summary} Open **${guide.nextStep.label}** below and I’ll keep the remaining setup in order.`
    : `${guide.summary} You can ask about exchanges, Paper mode, Autopilot, or risk controls.`;
}

export const askOnyxSetupGuide = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => askSchema.parse(input))
  .handler(async ({ context, data }) => {
    if (data.context !== "automation" && isMarketSetupQuestion(data.question)) {
      try {
        return {
          answer: await answerMarketSetupQuestion(context.userId),
          source: "market_scan" as const,
        };
      } catch {
        return {
          answer:
            "I could not complete the market scan right now. I did not change your account or place an order. Please try again shortly.",
          source: "market_scan" as const,
        };
      }
    }

    const guide = await readGuide(context.supabase, context.userId);
    const automation =
      data.context === "automation"
        ? await readAutomationContext(context.supabase, context.userId)
        : null;
    const fallback = automation
      ? automationFallback(automation, data.question)
      : fallbackAnswer(data.question, guide);
    const { data: profile } = await context.supabase
      .from("profiles")
      .select("ai_data_consent_at")
      .eq("id", context.userId)
      .maybeSingle();
    if (!profile?.ai_data_consent_at) {
      return { answer: fallback, source: "guided" as const };
    }
    const glm = resolveGlmTransport(process.env);
    const apiKey = glm.apiKey;
    if (!apiKey) return { answer: fallback, source: "guided" as const };
    const model = glm.model;

    const started = Date.now();
    try {
      const response = await fetch(glm.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          ...glmGenerationOptions(glm, 350),
          messages: [
            {
              role: "system",
              content:
                data.context === "automation"
                  ? "You are Onyx, TurtleBot's live automation setup guide. Walk the user through venue and wallet mapping, Turtle and symbol selection, optional Life Map target, fixed 5% current-wallet sizing across five rungs, schedule, risk limits, final approval, and monitoring. Explain only supplied account facts. Do not mention simulation or paper trading in this live context. You may advise and explain, but cannot save a plan, arm an order, or claim a venue fill. Do not claim a saved plan is running live; liveRows only means configured and armed. Never promise profits, request secrets, or imply a bill was paid. Keep answers under 120 words with one concrete next step."
                  : "You are Onyx, TurtleBot's concise setup guide. Explain only the supplied account setup state and how to use TurtleBot. Never claim custody, guarantee returns, give individualized investment advice, request secrets, or say a live order was placed. TurtleBot is non-custodial. Keep answers under 120 words and give one clear next action.",
            },
            {
              role: "user",
              content: JSON.stringify(
                data.context === "automation"
                  ? { question: data.question, automation }
                  : { question: data.question, setup: guide },
              ),
            },
          ],
        }),
      });
      if (!response.ok) {
        await recordRawAiUsage({
          userId: context.userId,
          feature: "setup_guide",
          provider: glm.provider,
          model,
          status: "error",
          latencyMs: Date.now() - started,
        });
        return { answer: fallback, source: "guided" as const };
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const answer = body.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error("empty response");
      await recordRawAiUsage({
        userId: context.userId,
        feature: "setup_guide",
        provider: glm.provider,
        model,
        status: "success",
        latencyMs: Date.now() - started,
        body,
      });
      return { answer, source: "ai" as const };
    } catch {
      await recordRawAiUsage({
        userId: context.userId,
        feature: "setup_guide",
        provider: glm.provider,
        model,
        status: "error",
        latencyMs: Date.now() - started,
      });
      return { answer: fallback, source: "guided" as const };
    }
  });
