import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { INTERNAL_LIVE_SYMBOLS } from "./liveOrder.js";

export const AsterEntryLifecycleSchema = z.object({
  connection_id: z.string().uuid(),
  client_order_id: z.string().min(8).max(64),
  symbol: z.enum(INTERNAL_LIVE_SYMBOLS),
  rung: z.number().int().min(1).max(5),
}).strict();

type Connection = {
  user_id: string; exchange: string; environment: string | null;
  status: string | null; permission_trade: boolean | null; permissions_verified: boolean | null;
};

export function registerAsterLifecycleRoutes(app: FastifyInstance, deps: {
  verifyBearer: (authorization: string | undefined) => Promise<{ sub: string }>;
  ownedConnection: (authorization: string, userId: string, connectionId: string) => Promise<Connection | null>;
  callSigner: (path: string, payload: Record<string, unknown>) => Promise<{
    ok: boolean; status: number; json: Record<string, unknown>;
  }>;
}) {
  for (const action of ["entry-status", "cancel-entry"] as const) {
    const path = `/v1/aster/${action}`;
    app.post(path, async (req, reply) => {
      const identity = await deps.verifyBearer(req.headers.authorization);
      const parsed = AsterEntryLifecycleSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "INVALID_ASTER_LIFECYCLE_REQUEST" });
      const input = parsed.data;
      const conn = await deps.ownedConnection(req.headers.authorization!, identity.sub, input.connection_id);
      if (!conn || conn.user_id !== identity.sub || ["disconnected", "disabled"].includes(conn.status ?? "")) {
        return reply.status(404).send({ error: "CONNECTION_NOT_FOUND" });
      }
      if (conn.exchange !== "aster" || !["mainnet", "production"].includes(conn.environment ?? "")) {
        return reply.status(409).send({ error: "ASTER_CONNECTION_MISMATCH" });
      }
      const cancel = action === "cancel-entry";
      if (cancel && (conn.status !== "verified" || conn.permission_trade !== true || conn.permissions_verified !== true)) {
        return reply.status(409).send({ error: "ASTER_TRADE_PERMISSION_UNVERIFIED" });
      }
      // Identity and target path come from verified server state, not from
      // caller-supplied user IDs, venue IDs, credentials or endpoint names.
      try {
        const result = await deps.callSigner(path, {
          user_id: identity.sub, exchange_connection_id: input.connection_id,
          client_order_id: input.client_order_id, symbol: input.symbol, rung: input.rung,
        });
        const status = result.json.status;
        const known = ["observed", "cancelled", "noop", "error", "ambiguous"].includes(String(status));
        if (!result.ok || !known) {
          return reply.status(result.status >= 400 ? result.status : 502).send({
            status: cancel ? "ambiguous" : "error", reject_reason: "ASTER_LIFECYCLE_UNCONFIRMED",
            correlation_id: req.id,
          });
        }
        return reply.send({
          status, exchange: "aster", connection_id: input.connection_id,
          campaign_orders: Array.isArray(result.json.campaign_orders) ? result.json.campaign_orders : [],
          reject_reason: typeof result.json.reject_reason === "string" ? result.json.reject_reason : null,
          correlation_id: req.id,
        });
      } catch {
        return reply.status(503).send({
          status: cancel ? "ambiguous" : "error", reject_reason: "ASTER_LIFECYCLE_UNCONFIRMED",
          correlation_id: req.id,
        });
      }
    });
  }
}
