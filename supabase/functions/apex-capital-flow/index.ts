import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { Annotation, END, START, StateGraph } from "npm:@langchain/langgraph@1.4.14";
import {
  isQuorumarkMvpMode,
  quorumarkMvpDisabledResponse,
} from "../_shared/quorumark-mvp-guard.ts";

type Action = "inspect" | "prepare" | "move_to_perps" | "return_to_funding";
type Ledger = { available: string; total: string; asset: string };
type Balances = { funding: Ledger; perps: Ledger };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

const State = Annotation.Root({
  action: Annotation<Action>(),
  connectionId: Annotation<string>(),
  requestId: Annotation<string>(),
  amount: Annotation<string | null>(),
  token: Annotation<string>(),
  userId: Annotation<string>(),
  status: Annotation<string>(),
  message: Annotation<string>(),
  balances: Annotation<Balances | null>(),
  receipt: Annotation<Record<string, unknown> | null>(),
  userActionRequired: Annotation<boolean>(),
  nextAction: Annotation<string | null>(),
});

async function callBroker(
  state: typeof State.State,
  operation: "READ_CAPITAL" | "MOVE_FUNDING_TO_PERPS" | "MOVE_PERPS_TO_FUNDING",
) {
  const base = Deno.env.get("TURTLE_BROKER_BASE_URL");
  const proxy =
    Deno.env.get("TURTLE_CAPITAL_PROXY_URL") ??
    "https://www.turtlebot.app/api/internal/apex-capital";
  const target = base ? `${base.replace(/\/$/, "")}/v1/capital` : proxy;
  const response = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      connection_id: state.connectionId,
      operation,
      amount: operation === "READ_CAPITAL" ? undefined : state.amount,
      asset: "USDT",
      idempotency_key: `cap-${state.requestId}`,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? "CAPITAL_BROKER_FAILED"));
  return body;
}

const graph = new StateGraph(State)
  .addNode("read_balances", async (state) => {
    const result = await callBroker(state, "READ_CAPITAL");
    const balances = (result.balances ?? null) as Balances | null;
    if (!balances) throw new Error("CAPITAL_BALANCES_UNAVAILABLE");
    return { balances };
  })
  .addNode("plan", (state) => {
    if (state.action === "inspect") {
      return {
        status: "ready",
        message: "ApeX Funding and Perps balances are current.",
        userActionRequired: false,
        nextAction: null,
      };
    }
    if (state.action === "prepare") {
      const funding = Number(state.balances?.funding.available ?? 0);
      // ApeX can leave sub-cent settlement dust in Funding. It cannot support
      // a meaningful USDT allocation and should not be presented as usable.
      return funding >= 0.01
        ? {
            status: "funding_detected",
            message: "Funding balance detected. Choose the amount to allocate to Perps.",
            userActionRequired: true,
            nextAction: "move_to_perps",
          }
        : {
            status: "awaiting_wallet_deposit",
            message: "No usable ApeX Funding balance. Deposit with your wallet, then confirm here.",
            userActionRequired: true,
            nextAction: "open_apex_deposit",
          };
    }
    return {
      status: "authorized",
      message:
        state.action === "move_to_perps"
          ? "Funding allocation authorized."
          : "Return to Funding authorized.",
      userActionRequired: false,
      nextAction: null,
    };
  })
  .addNode("move", async (state) => {
    const operation =
      state.action === "move_to_perps" ? "MOVE_FUNDING_TO_PERPS" : "MOVE_PERPS_TO_FUNDING";
    const result = await callBroker(state, operation);
    return {
      status: "submitted",
      message:
        state.action === "move_to_perps"
          ? "Funding → Perps allocation submitted to ApeX."
          : "Perps → Funding return submitted to ApeX.",
      receipt: (result.receipt ?? null) as Record<string, unknown> | null,
      userActionRequired: false,
      nextAction: "inspect",
    };
  })
  .addEdge(START, "read_balances")
  .addEdge("read_balances", "plan")
  .addConditionalEdges("plan", (state) =>
    state.action === "move_to_perps" || state.action === "return_to_funding" ? "move" : END,
  )
  .addEdge("move", END)
  .compile();

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, message: "POST required." });
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const url = Deno.env.get("SUPABASE_URL");
  const role = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !role) return json(500, { ok: false, message: "Capital workflow unavailable." });
  const admin = createClient(url, role, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return json(401, { ok: false, message: "Sign in required." });
  if (isQuorumarkMvpMode()) return quorumarkMvpDisabledResponse("apex-capital-flow", cors);

  try {
    const body = (await req.json()) as {
      action?: Action;
      connection_id?: string;
      amount?: string;
      request_id?: string;
    };
    const action = body.action;
    const connectionId = String(body.connection_id ?? "");
    const requestId = String(body.request_id ?? "");
    const amount = body.amount == null ? null : String(body.amount);
    if (!action || !["inspect", "prepare", "move_to_perps", "return_to_funding"].includes(action)) {
      return json(400, { ok: false, message: "Invalid capital action." });
    }
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) {
      return json(400, { ok: false, message: "Invalid ApeX connection." });
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    ) {
      return json(400, { ok: false, message: "Invalid capital request ID." });
    }
    if (
      (action === "move_to_perps" || action === "return_to_funding") &&
      (!amount || !/^\d+(?:\.\d{1,8})?$/.test(amount) || Number(amount) <= 0)
    ) {
      return json(400, { ok: false, message: "Enter a positive USDT amount." });
    }

    const { data: connection } = await admin
      .from("exchange_connections")
      .select("id,exchange,environment,status")
      .eq("id", connectionId)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (!connection || connection.exchange !== "apex_omni") {
      return json(404, { ok: false, message: "ApeX connection not found." });
    }
    if (action === "return_to_funding") {
      const { count, error } = await admin
        .from("positions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", auth.user.id)
        .eq("source", "live")
        .eq("status", "open");
      if (error) return json(503, { ok: false, message: "Could not verify open positions." });
      if ((count ?? 0) > 0) {
        return json(409, {
          ok: false,
          status: "blocked_open_positions",
          message:
            "Close and reconcile every live position before returning Perps capital to Funding.",
        });
      }
    }

    const isMove = action === "move_to_perps" || action === "return_to_funding";
    if (isMove) {
      const { error: reserveError } = await admin.from("capital_transfer_intents").insert({
        request_id: requestId,
        user_id: auth.user.id,
        exchange_connection_id: connectionId,
        action,
        asset: "USDT",
        amount,
        status: "pending",
      });
      if (reserveError?.code === "23505") {
        const { data: prior } = await admin
          .from("capital_transfer_intents")
          .select("action,amount,status,result")
          .eq("user_id", auth.user.id)
          .eq("request_id", requestId)
          .maybeSingle();
        if (
          !prior ||
          prior.action !== action ||
          !Number.isFinite(Number(prior.amount)) ||
          Number(prior.amount) !== Number(amount)
        ) {
          return json(409, {
            ok: false,
            message: "Capital request ID was reused with different instructions.",
          });
        }
        if (prior.status === "submitted" && prior.result && typeof prior.result === "object") {
          return json(200, prior.result as Record<string, unknown>);
        }
        return json(409, {
          ok: false,
          message:
            prior.status === "pending"
              ? "This capital transfer is already being processed."
              : "This transfer had an uncertain result. Check balances before trying a new request.",
        });
      }
      if (reserveError) {
        return json(503, { ok: false, message: "Could not reserve the capital transfer safely." });
      }
    }

    try {
      const result = await graph.invoke({
        action,
        connectionId,
        requestId,
        amount,
        token,
        userId: auth.user.id,
        status: "starting",
        message: "",
        balances: null,
        receipt: null,
        userActionRequired: false,
        nextAction: null,
      });
      const response = {
        ok: true,
        status: result.status,
        message: result.message,
        balances: result.balances,
        receipt: result.receipt,
        user_action_required: result.userActionRequired,
        next_action: result.nextAction,
        external_withdrawal_enabled: false,
      };
      if (isMove) {
        await admin
          .from("capital_transfer_intents")
          .update({ status: "submitted", result: response, completed_at: new Date().toISOString() })
          .eq("user_id", auth.user.id)
          .eq("request_id", requestId);
      }
      return json(200, response);
    } catch (error) {
      if (isMove) {
        await admin
          .from("capital_transfer_intents")
          .update({ status: "uncertain", error_code: "BROKER_OR_VENUE_ERROR" })
          .eq("user_id", auth.user.id)
          .eq("request_id", requestId);
      }
      throw error;
    }
  } catch (error) {
    return json(502, {
      ok: false,
      message: error instanceof Error ? error.message : "Capital workflow failed.",
    });
  }
});
