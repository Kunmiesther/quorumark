/**
 * Authenticated, fixed-destination bridge from the Supabase LangGraph workflow
 * to TurtleBot's Railway broker.
 *
 * Vercel already owns TURTLE_BROKER_BASE_URL for onboarding and live canaries.
 * Keeping that private deployment address here avoids copying it into a second
 * platform. The caller's Supabase JWT is forwarded unchanged; the broker still
 * verifies identity, connection ownership, environment, execution halt state,
 * and feature flags before it can contact the private signer.
 */
import { createFileRoute } from "@tanstack/react-router";
import { quorumarkMvpDisabledResponse } from "@/lib/quorumark-mvp-policy.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT = /^\d+(?:\.\d{1,8})?$/;
const OPERATIONS = new Set(["READ_CAPITAL", "MOVE_FUNDING_TO_PERPS", "MOVE_PERPS_TO_FUNDING"]);

type CapitalBody = {
  connection_id?: unknown;
  operation?: unknown;
  amount?: unknown;
  asset?: unknown;
  idempotency_key?: unknown;
};

function validBody(value: unknown): value is CapitalBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as CapitalBody;
  if (typeof body.connection_id !== "string" || !UUID.test(body.connection_id)) return false;
  if (typeof body.operation !== "string" || !OPERATIONS.has(body.operation)) return false;
  if (body.asset !== "USDT") return false;
  if (
    typeof body.idempotency_key !== "string" ||
    body.idempotency_key.length < 8 ||
    body.idempotency_key.length > 64
  ) {
    return false;
  }
  if (body.operation === "READ_CAPITAL") return body.amount == null;
  return typeof body.amount === "string" && AMOUNT.test(body.amount) && Number(body.amount) > 0;
}

export const Route = createFileRoute("/api/internal/apex-capital")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        if (!/^Bearer\s+\S+$/i.test(authorization)) {
          return Response.json({ error: "AUTH_REQUIRED" }, { status: 401 });
        }
        if (process.env.QUORUMARK_MVP_MODE !== "disabled") {
          return quorumarkMvpDisabledResponse("apex-capital");
        }

        const brokerUrl = process.env["TURTLE_BROKER_BASE_URL"]?.replace(/\/$/, "");
        if (!brokerUrl) {
          return Response.json({ error: "BROKER_NOT_CONFIGURED" }, { status: 503 });
        }

        const raw = await request.text();
        if (raw.length > 4096) {
          return Response.json({ error: "INVALID_CAPITAL_REQUEST" }, { status: 413 });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return Response.json({ error: "INVALID_CAPITAL_REQUEST" }, { status: 400 });
        }
        if (!validBody(parsed)) {
          return Response.json({ error: "INVALID_CAPITAL_REQUEST" }, { status: 400 });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch(`${brokerUrl}/v1/capital`, {
            method: "POST",
            headers: {
              authorization,
              "content-type": "application/json",
            },
            body: raw,
            signal: controller.signal,
          });
          const responseBody = await response.text();
          return new Response(responseBody, {
            status: response.status,
            headers: { "content-type": "application/json" },
          });
        } catch {
          return Response.json({ error: "BROKER_UNREACHABLE" }, { status: 503 });
        } finally {
          clearTimeout(timeout);
        }
      },
    },
  },
});
