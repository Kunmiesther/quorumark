import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { registerAsterLifecycleRoutes } from "../asterLifecycle.js";

const input = { connection_id: "00000000-0000-4000-8000-000000000002",
  client_order_id: "decision-1234", symbol: "BTC-USDT", rung: 1 };

function setup() {
  const app = Fastify();
  const conn = { user_id: "verified-owner", exchange: "aster", environment: "mainnet",
    status: "verified", permission_trade: true, permissions_verified: true };
  const deps = {
    verifyBearer: vi.fn(async () => ({ sub: "verified-owner" })),
    ownedConnection: vi.fn(async () => conn),
    callSigner: vi.fn(async () => ({ ok: true, status: 200,
      json: { status: "observed", campaign_orders: [] } as Record<string, unknown> })),
  };
  registerAsterLifecycleRoutes(app, deps);
  const send = (action = "entry-status", payload = input) => app.inject({
    method: "POST", url: `/v1/aster/${action}`, headers: { authorization: "Bearer verified" }, payload,
  });
  return { app, conn, deps, send };
}

describe("Aster lifecycle gateway", () => {
  it("forwards only the verified owner and selected connection", async () => {
    const { app, deps, send } = setup();
    try {
      expect((await send()).statusCode).toBe(200);
      expect(deps.callSigner).toHaveBeenCalledWith("/v1/aster/entry-status", {
        user_id: "verified-owner", exchange_connection_id: input.connection_id,
        client_order_id: input.client_order_id, symbol: input.symbol, rung: 1,
      });
    } finally { await app.close(); }
  });

  it.each(["user_id", "api_secret", "order_id", "path"])("rejects caller-controlled %s", async (field) => {
    const { app, deps, send } = setup();
    try {
      expect((await send("cancel-entry", { ...input, [field]: "untrusted" })).statusCode).toBe(400);
      expect(deps.callSigner).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each(["user_id", "exchange", "permission_trade"])("refuses incorrect %s", async (field) => {
    const { app, conn, deps, send } = setup();
    Object.assign(conn, { [field]: field === "permission_trade" ? false : "other" });
    try {
      expect((await send("cancel-entry")).statusCode).toBeGreaterThanOrEqual(400);
      expect(deps.callSigner).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("does not reach signer when authentication fails", async () => {
    const { app, deps, send } = setup();
    deps.verifyBearer.mockRejectedValue(new Error("invalid token"));
    try {
      expect((await send()).statusCode).toBeGreaterThanOrEqual(400);
      expect(deps.ownedConnection).not.toHaveBeenCalled();
      expect(deps.callSigner).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("keeps cancellation uncertainty when signer times out", async () => {
    const { app, deps, send } = setup();
    deps.callSigner.mockRejectedValue(new Error("timeout"));
    try {
      const response = await send("cancel-entry");
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe("ambiguous");
      expect(deps.callSigner).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  it("never presents an unrecognized response as successful cancellation", async () => {
    const { app, deps, send } = setup();
    deps.callSigner.mockResolvedValue({ ok: true, status: 200, json: {} });
    try {
      const response = await send("cancel-entry");
      expect(response.statusCode).toBe(502);
      expect(response.json().status).toBe("ambiguous");
    } finally { await app.close(); }
  });
});
