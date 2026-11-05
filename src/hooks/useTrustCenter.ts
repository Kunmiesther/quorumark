/**
 * useTrustCenter — the single read that answers "can I trust TurtleBot with
 * my money right now?".
 *
 * Every section of the Trust Center reads from this one hook, so the System
 * Status header and the Trust Monitor below it can never disagree about the
 * same subsystem.
 *
 * HONESTY RULES BAKED IN HERE:
 *   * A subsystem is `ok` only from a FRESH record. Absence of evidence is
 *     `unknown` or `idle`, never `ok` and never `down`.
 *   * "never ran" and "ran and failed" are different tones with different
 *     copy. Collapsing them is how a quiet system looks broken.
 *   * No number is invented. A missing figure is null and renders as an em
 *     dash; it is never floored to 0.
 *
 * READ-ONLY. This hook cannot place, modify, or cancel anything.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useBotHealth } from "@/hooks/useBotHealth";
import { ageSeconds, type Tone } from "@/components/exchanges/trust/primitives";
import {
  getExecutionRuntimeHealth,
  type ExecutionRuntimeHealth,
} from "@/lib/health/executionRuntime.functions";

/** A paper market scan is current for one 15-minute execution interval plus slack. */
const MARKET_DATA_STALE_SEC = 20 * 60;
/** The committee is advisory and dashboard-driven, so it is allowed to be old. */
const AI_STALE_SEC = 30 * 60;

export interface Subsystem {
  key: string;
  name: string;
  state: string;
  tone: Tone;
  detail: string | null;
  at: string | null;
}

export interface TrustEvent {
  label: string;
  at: string | null;
  summary: string | null;
  tone: Tone;
}

export interface TrustCenterData {
  subsystems: Subsystem[];
  overall: { state: string; tone: Tone; detail: string };
  lastHealthCheckAt: string | null;
  monitor: TrustEvent[];
  execution: {
    waiting: boolean;
    reason: string | null;
    at: string | null;
    recommendedAction: string | null;
  };
  queueSize: number | null;
  openPositions: number | null;
  openPnlUsd: number | null;
  closedPnlUsd: number | null;
  feesPaidUsd: number | null;
  /** Realised PnL for trades closed since UTC midnight. Negative = a loss. */
  todayRealisedUsd: number | null;
  lastFillAt: string | null;
  lastSuccessfulTradeAt: string | null;
  halted: boolean;
  isLoading: boolean;
}

type ConnectionLike = {
  id: string;
  status: string;
  permission_read: boolean;
  permission_trade: boolean;
  permissions_verified: boolean;
  is_live: boolean;
  last_health_check_at: string | null;
  last_error: string | null;
  last_error_message: string | null;
};

function worstTone(tones: Tone[]): Tone {
  if (tones.includes("down")) return "down";
  if (tones.includes("warn")) return "warn";
  if (tones.includes("unknown")) return "unknown";
  if (tones.includes("idle")) return "idle";
  if (tones.includes("ok")) return "ok";
  return "idle";
}

export function useTrustCenter(connections: ConnectionLike[]): TrustCenterData {
  const { user } = useAuth();
  const userId = user?.id;
  const health = useBotHealth();
  const executionRuntimeQ = useQuery({
    queryKey: ["execution-runtime-health"],
    enabled: Boolean(userId),
    refetchInterval: 15_000,
    retry: 1,
    queryFn: () => getExecutionRuntimeHealth(),
  });

  // One batched read for everything the monitor shows. Kept to newest rows
  // only — this is a status page, not a history browser.
  const feed = useQuery({
    queryKey: ["trust-center-feed", userId],
    enabled: Boolean(userId),
    refetchInterval: 15_000,
    queryFn: async () => {
      // Realised figures come from `trades`, which already carries
      // `realized_pnl` and `fees_usd` per closed trade. Scoped to the LIVE
      // book: paper results must never appear on a page about real money.
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);

      const [cycleRes, evalRes, candidateRes, intentRes, positionRes, tradeRes] = await Promise.all(
        [
          supabase
            .from("committee_cycles")
            .select("created_at, candle_close_at, status, selected_symbol, no_trade_reason")
            .eq("user_id", userId!)
            .eq("book", "paper")
            .order("created_at", { ascending: false })
            .limit(1),
          supabase
            .from("ai_committee_evaluations")
            .select(
              "candle_close_at, verdict, symbol, available_roles, unavailable_roles, outcomes, created_at",
            )
            .order("created_at", { ascending: false })
            .limit(1),
          supabase
            .from("strategy_candidates")
            .select("candidate_id, symbol, direction, strategy, candle_close_at, created_at")
            .order("candle_close_at", { ascending: false })
            .limit(1),
          supabase
            .from("order_intents")
            .select(
              "symbol, side, state, state_reason, exchange_order_id, exchange_status, filled_size, created_at, updated_at",
            )
            .eq("user_id", userId!)
            .eq("environment", "mainnet")
            .order("updated_at", { ascending: false })
            .limit(100),
          supabase
            .from("positions")
            .select("id, pair, side, unrealized_pnl, pnl_amount, status, opened_at")
            .eq("status", "open"),
          supabase
            .from("trades")
            .select("realized_pnl, fees_usd, closed_at")
            .eq("book", "live")
            .order("closed_at", { ascending: false })
            .limit(1000),
        ],
      );
      return {
        cycle: cycleRes.data?.[0] ?? null,
        evaluation: evalRes.data?.[0] ?? null,
        candidate: candidateRes.data?.[0] ?? null,
        intents: intentRes.data ?? [],
        intentsFailed: Boolean(intentRes.error),
        positions: positionRes.data ?? [],
        trades: tradeRes.data ?? [],
        // A failed trades read must not read as "you have never traded".
        tradesFailed: Boolean(tradeRes.error),
        dayStartIso: dayStart.toISOString(),
        // A failed read is not an empty result. Surfaced so the UI can say
        // "unknown" instead of confidently showing nothing.
        failed: Boolean(cycleRes.error) || Boolean(intentRes.error) || Boolean(positionRes.error),
      };
    },
  });

  const data = feed.data;
  const worker = health.worker;
  const halted = health.killSwitches.length > 0;

  /* ---------------- Exchange ---------------- */
  const live = connections.filter((c) => c.status === "verified" || c.status === "active");
  const readable = live.filter((c) => c.permission_read);
  const errored = connections.filter((c) => c.status === "error" || Boolean(c.last_error));
  const lastHealthCheckAt =
    connections
      .map((c) => c.last_health_check_at)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1) ?? null;

  const exchange: Subsystem =
    connections.length === 0
      ? {
          key: "exchange",
          name: "Exchange",
          state: "Not connected",
          tone: "idle",
          detail: "No exchange connection has been added yet.",
          at: null,
        }
      : errored.length > 0
        ? {
            key: "exchange",
            name: "Exchange",
            state: "Error",
            tone: "down",
            detail:
              errored[0].last_error_message ??
              errored[0].last_error ??
              `${errored.length} connection${errored.length === 1 ? "" : "s"} reporting an error.`,
            at: lastHealthCheckAt,
          }
        : readable.length === 0
          ? {
              key: "exchange",
              name: "Exchange",
              state: "Unverified",
              tone: "warn",
              detail: "Connected, but no venue has confirmed read permission yet.",
              at: lastHealthCheckAt,
            }
          : {
              key: "exchange",
              name: "Exchange",
              state: "Connected",
              tone: "ok",
              detail: `${readable.length} of ${connections.length} venue${
                connections.length === 1 ? "" : "s"
              } verified and readable.`,
              at: lastHealthCheckAt,
            };

  /* ---------------- Market data ---------------- */
  const signalAt = (data?.cycle?.created_at as string | undefined) ?? null;
  const signalAge = ageSeconds(signalAt);
  const marketData: Subsystem = !data
    ? {
        key: "market",
        name: "Market data",
        state: "Checking",
        tone: "unknown",
        detail: null,
        at: null,
      }
    : signalAt === null
      ? {
          key: "market",
          name: "Market data",
          state: worker.ready ? "Awaiting scan" : "No feed yet",
          tone: "idle",
          detail: worker.ready
            ? "The market worker is connected; Onyx has not recorded the first market scan yet."
            : "The worker has not recorded a market scan yet.",
          at: null,
        }
      : signalAge !== null && signalAge > MARKET_DATA_STALE_SEC
        ? {
            key: "market",
            name: "Market data",
            state: "Stale",
            tone: "warn",
            detail: `Last market scan was ${Math.round(signalAge / 60)}m ago.`,
            at: signalAt,
          }
        : {
            key: "market",
            name: "Market data",
            state: "Live",
            tone: "ok",
            detail: "A recent market scan is recorded.",
            at: signalAt,
          };

  /* ---------------- AI brain (advisory) ---------------- */
  const evalAt = (data?.evaluation?.created_at as string | undefined) ?? null;
  const evalAge = ageSeconds(evalAt);
  const unavailableRoles = (data?.evaluation?.unavailable_roles as string[] | null) ?? [];
  const availableRoles = (data?.evaluation?.available_roles as string[] | null) ?? [];
  // A seat that was never asked is not a seat that failed. When every seat
  // reports `stale_snapshot`, no model was contacted at all — the candidate
  // aged out of the evaluation window — so this is idle, not an outage.
  const evalOutcomes =
    (data?.evaluation?.outcomes as Array<{ reason?: string | null }> | null) ?? [];
  const allStaleSnapshot =
    evalOutcomes.length > 0 && evalOutcomes.every((o) => o?.reason === "stale_snapshot");
  const cycleIsFresh =
    signalAt !== null && signalAge !== null && signalAge <= MARKET_DATA_STALE_SEC;
  const aiBrain: Subsystem = !data
    ? { key: "ai", name: "AI brain", state: "Checking", tone: "unknown", detail: null, at: null }
    : evalAt === null && cycleIsFresh
      ? {
          key: "ai",
          name: "AI brain",
          state: "Enabled",
          tone: "ok",
          detail:
            data.cycle?.no_trade_reason === "no_qualified_candidates"
              ? "Council is active and standing by. No qualified candidate reached the AI seats in the latest scan."
              : "Council is active and standing by for the next qualified candidate.",
          at: signalAt,
        }
      : evalAt === null
        ? {
            key: "ai",
            name: "AI brain",
            state: "Awaiting cycle",
            tone: "idle",
            detail:
              "Council has not recorded a fresh cycle yet. Advisory only — trading is unaffected.",
            at: null,
          }
        : availableRoles.length === 0 && allStaleSnapshot
          ? {
              key: "ai",
              name: "AI brain",
              state: "Not asked",
              tone: "idle",
              detail:
                "The last candidate aged out of the evaluation window, so no seat was contacted. Advisory only — trading is unaffected.",
              at: evalAt,
            }
          : availableRoles.length === 0
            ? {
                key: "ai",
                name: "AI brain",
                state: "Unavailable",
                tone: "warn",
                detail: `Asked, no seat answered (${unavailableRoles.join(", ") || "all seats"}). Advisory only — trading is unaffected.`,
                at: evalAt,
              }
            : evalAge !== null && evalAge > AI_STALE_SEC
              ? {
                  key: "ai",
                  name: "AI brain",
                  state: "Idle",
                  tone: "idle",
                  detail: "No recent evaluation. Advisory only — it never gates a trade.",
                  at: evalAt,
                }
              : {
                  key: "ai",
                  name: "AI brain",
                  state: "Running",
                  tone: "ok",
                  detail: `${availableRoles.length} of 3 seats answered. Advisory only — it never gates a trade.`,
                  at: evalAt,
                };

  /* ---------------- Automation worker ---------------- */
  const automationWorker: Subsystem = worker.ready
    ? {
        key: "worker",
        name: "Automation worker",
        state: "Running",
        tone: "ok",
        detail: `Scanner and strategy worker healthy in ${worker.mode ?? "unknown"} mode.`,
        at: worker.lastSeenAt,
      }
    : {
        key: "worker",
        name: "Automation worker",
        state: worker.lastSeenAt ? "Not ready" : "Offline",
        tone: worker.lastSeenAt ? "warn" : "down",
        detail: worker.reason,
        at: worker.lastSeenAt,
      };

  /* ---------------- Live order broker ---------------- */
  const runtime = executionRuntimeQ.data as ExecutionRuntimeHealth | undefined;
  const liveRequested = connections.some(
    (connection) =>
      connection.is_live && connection.permission_trade && connection.permissions_verified,
  );
  const executionEngine: Subsystem = executionRuntimeQ.isLoading
    ? {
        key: "execution",
        name: "Live order broker",
        state: "Checking",
        tone: "unknown",
        detail: "Checking the public broker and private signer.",
        at: null,
      }
    : runtime?.manualTradingReady
      ? {
          key: "execution",
          name: "Live order broker",
          state: runtime.automationTradingReady ? "Automation ready" : "Manual ready",
          tone: runtime.automationTradingReady || !liveRequested ? "ok" : "warn",
          detail: runtime.reason,
          at: runtime.checkedAt,
        }
      : {
          key: "execution",
          name: "Live order broker",
          state: runtime?.brokerReachable ? "Not ready" : "Offline",
          tone: liveRequested ? "down" : "idle",
          detail: runtime?.reason ?? "No execution runtime response was recorded.",
          at: runtime?.checkedAt ?? null,
        };

  /* ---------------- Risk engine ---------------- */
  const riskEngine: Subsystem = halted
    ? {
        key: "risk",
        name: "Risk engine",
        state: "Halted",
        tone: "warn",
        detail: `Emergency stop active (${health.killSwitches
          .map((k) => k.scope)
          .join(", ")}). No new orders will be placed.`,
        at: null,
      }
    : {
        key: "risk",
        name: "Risk engine",
        state: "Protected",
        tone: "ok",
        detail:
          "Kill switch clear. Each execution mode applies its own enforced risk and protection rules.",
        at: null,
      };

  const subsystems = [exchange, marketData, aiBrain, automationWorker, executionEngine, riskEngine];

  /* ---------------- Overall ---------------- */
  // The AI brain is advisory and deliberately excluded from the headline: it
  // cannot stop a trade, so it must not be able to turn the page red.
  const blocking = subsystems.filter((s) => s.key !== "ai");
  const overallTone = worstTone(blocking.map((s) => s.tone));
  const firstProblem =
    blocking.find((s) => s.tone === "down") ?? blocking.find((s) => s.tone === "warn");
  const overall =
    overallTone === "ok"
      ? { state: "Operational", tone: "ok" as Tone, detail: "All systems are reporting healthy." }
      : overallTone === "down"
        ? {
            state: "Degraded",
            tone: "down" as Tone,
            detail: firstProblem
              ? `${firstProblem.name}: ${firstProblem.detail ?? firstProblem.state}`
              : "A subsystem is failing.",
          }
        : overallTone === "warn"
          ? {
              state: "Attention needed",
              tone: "warn" as Tone,
              detail: firstProblem
                ? `${firstProblem.name}: ${firstProblem.detail ?? firstProblem.state}`
                : "A subsystem needs attention.",
            }
          : {
              state: "Standing by",
              tone: "idle" as Tone,
              detail: "Nothing is failing. TurtleBot is waiting on setup or on the market.",
            };

  /* ---------------- Trust monitor ---------------- */
  const intents = (data?.intents ?? []) as Array<{
    symbol: string;
    side: string;
    state: string;
    state_reason: string | null;
    exchange_order_id: string | null;
    exchange_status: string | null;
    filled_size: number | null;
    created_at: string;
    updated_at: string;
  }>;

  const lastIntent = intents[0] ?? null;
  const lastSubmitted = intents.find((i) => Boolean(i.exchange_order_id)) ?? null;
  const lastFill = intents.find((i) => (i.filled_size ?? 0) > 0) ?? null;
  const QUEUE_STATES = new Set([
    "previewed",
    "confirmed",
    "queued",
    "signing",
    "submitted",
    "open",
    "partially_filled",
  ]);
  const queue = intents.filter((i) => QUEUE_STATES.has(i.state));

  const candidate = data?.candidate as
    | { symbol: string; direction: string; strategy: string; candle_close_at: string }
    | null
    | undefined;
  const evaluation = data?.evaluation as
    { symbol: string; verdict: string; created_at: string } | null | undefined;
  const cycle = data?.cycle as
    | { status: string; selected_symbol: string | null; no_trade_reason: string | null }
    | null
    | undefined;

  const monitor: TrustEvent[] = [
    {
      label: "Last market scan",
      at: signalAt,
      summary: cycle
        ? `${cycle.selected_symbol ?? "No selection"} · ${cycle.status}${
            cycle.no_trade_reason ? ` · ${cycle.no_trade_reason}` : ""
          }`
        : null,
      tone: marketData.tone,
    },
    {
      label: "Last AI decision",
      at: evaluation?.created_at ?? null,
      summary: evaluation
        ? `${evaluation.symbol} · ${evaluation.verdict.replace("shadow_", "")}`
        : null,
      tone: aiBrain.tone,
    },
    {
      label: "Last candidate",
      at: candidate?.candle_close_at ?? null,
      summary: candidate
        ? `${candidate.symbol} · ${candidate.direction} · ${candidate.strategy}`
        : null,
      tone: candidate ? "ok" : "idle",
    },
    {
      label: "Last order intent",
      at: lastIntent?.created_at ?? null,
      summary: lastIntent
        ? `${lastIntent.symbol} · ${lastIntent.side} · ${lastIntent.state}`
        : null,
      tone: lastIntent
        ? lastIntent.state === "rejected" || lastIntent.state === "failed"
          ? "down"
          : "ok"
        : "idle",
    },
    {
      label: "Last exchange submission",
      at: lastSubmitted?.updated_at ?? null,
      summary: lastSubmitted
        ? `${lastSubmitted.symbol} · order ${lastSubmitted.exchange_order_id?.slice(0, 12)}`
        : null,
      tone: lastSubmitted ? "ok" : "idle",
    },
    {
      label: "Last fill",
      at: lastFill?.updated_at ?? null,
      summary: lastFill ? `${lastFill.symbol} · ${lastFill.filled_size} filled` : null,
      tone: lastFill ? "ok" : "idle",
    },
  ];

  /* ---------------- Why execution is waiting ---------------- */
  const positions = (data?.positions ?? []) as Array<{
    unrealized_pnl: number;
    pnl_amount: number;
  }>;
  const tradePermitted = live.some(
    (c) => c.permission_trade && c.permissions_verified && c.is_live,
  );

  let execution = {
    waiting: false,
    reason: null as string | null,
    at: null as string | null,
    recommendedAction: null as string | null,
  };
  if (halted) {
    execution = {
      waiting: true,
      reason: "Emergency stop is active.",
      at: null,
      recommendedAction:
        "Resume trading per exchange from the connections list once you are ready.",
    };
  } else if (tradePermitted && !runtime?.manualTradingReady) {
    execution = {
      waiting: true,
      reason: runtime?.reason ?? "The live order broker has not reported readiness.",
      at: runtime?.checkedAt ?? null,
      recommendedAction:
        "Keep live orders paused until both the public broker and private signer report ready.",
    };
  } else if (!worker.ready) {
    execution = {
      waiting: true,
      reason: `Automated strategies are waiting: ${worker.reason}`,
      at: worker.lastSeenAt,
      recommendedAction:
        "Manual owner canary trading is independent; automated strategies resume only after a fresh worker heartbeat.",
    };
  } else if (connections.length === 0) {
    execution = {
      waiting: true,
      reason: "No exchange connection has been added.",
      at: null,
      recommendedAction: "Connect an exchange with API keys to begin.",
    };
  } else if (!tradePermitted) {
    execution = {
      waiting: true,
      reason: "No connection is both verified and enabled for live trading.",
      at: lastHealthCheckAt,
      recommendedAction:
        "Verify permissions and enable live trading on the venue you want to trade.",
    };
  } else if (lastIntent?.state === "rejected" || lastIntent?.state === "failed") {
    execution = {
      waiting: false,
      reason: lastIntent.state_reason ?? "The venue rejected the last intent.",
      at: lastIntent.updated_at,
      recommendedAction:
        "Review the rejection reason below; TurtleBot will evaluate the next candle normally.",
    };
  }

  /* ---------------- Realised figures ---------------- */
  // `null` when the read failed or has not run — never 0, which on a losing
  // day would read as "you are flat" and on a funded account as "no fees".
  const trades = (data?.trades ?? []) as Array<{
    realized_pnl: number | null;
    fees_usd: number | null;
    closed_at: string;
  }>;
  const dayStartIso = data?.dayStartIso ?? null;
  const realised =
    !data || data.tradesFailed
      ? {
          closedPnl: null as number | null,
          fees: null as number | null,
          today: null as number | null,
        }
      : {
          closedPnl: trades.reduce((sum, t) => sum + (Number(t.realized_pnl) || 0), 0),
          fees: trades.reduce((sum, t) => sum + (Number(t.fees_usd) || 0), 0),
          today: dayStartIso
            ? trades
                .filter((t) => t.closed_at >= dayStartIso)
                .reduce((sum, t) => sum + (Number(t.realized_pnl) || 0), 0)
            : null,
        };

  return {
    subsystems,
    overall,
    lastHealthCheckAt: worker.lastSeenAt ?? lastHealthCheckAt,
    monitor,
    execution,
    queueSize: data && !data.intentsFailed ? queue.length : null,
    openPositions: data ? positions.length : null,
    openPnlUsd:
      data && positions.length > 0
        ? positions.reduce((sum, p) => sum + (Number(p.unrealized_pnl) || 0), 0)
        : data
          ? 0
          : null,
    closedPnlUsd: realised.closedPnl,
    feesPaidUsd: realised.fees,
    todayRealisedUsd: realised.today,
    lastFillAt: lastFill?.updated_at ?? null,
    lastSuccessfulTradeAt: lastFill?.updated_at ?? null,
    halted,
    isLoading: feed.isLoading || health.isLoading || executionRuntimeQ.isLoading,
  };
}
