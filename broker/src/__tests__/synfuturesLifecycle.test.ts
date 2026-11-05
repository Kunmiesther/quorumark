import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { registerSynFuturesLifecycleRoutes } from "../synfuturesLifecycle.js";

const input = { connection_id: "00000000-0000-4000-8000-000000000002" };
function setup() {
  const app = Fastify();
  const conn = { user_id: "owner", exchange: "synfutures", environment: "mainnet" };
  const deps = {
    verifyBearer: vi.fn(async () => ({ sub: "owner" })),
    ownedConnection: vi.fn(async () => conn),
    callSigner: vi.fn(async () => ({ ok: true, status: 200, json: {
      status: "reconciled", reconciliation_required: false,
    } as Record<string, unknown> })),
  };
  registerSynFuturesLifecycleRoutes(app, deps);
  const send = (payload = input) => app.inject({ method: "POST", url: "/v1/synfutures/reconcile-orders",
    headers: { authorization: "Bearer verified" }, payload });
  return { app, conn, deps, send };
}
describe("SynFutures receipt recovery gateway", () => {
  it("derives identity and fixed signer path on the server", async () => {
    const { app, deps, send } = setup();
    try {
      expect((await send()).statusCode).toBe(200);
      expect(deps.callSigner).toHaveBeenCalledWith("/v1/synfutures/reconcile-orders", {
        user_id: "owner", exchange_connection_id: input.connection_id,
      });
    } finally { await app.close(); }
  });
  it.each(["user_id", "tx_hash", "private_key", "rpc_url", "module_address"])("rejects injected %s", async field => {
    const { app, deps, send } = setup();
    try {
      expect((await send({ ...input, [field]: "untrusted" })).statusCode).toBe(400);
      expect(deps.callSigner).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(["user_id", "exchange", "environment"])("rejects wrong %s", async field => {
    const { app, conn, deps, send } = setup();
    Object.assign(conn, { [field]: "other" });
    try {
      expect((await send()).statusCode).toBeGreaterThanOrEqual(400);
      expect(deps.callSigner).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("does not retry timeouts or claim success", async () => {
    const { app, deps, send } = setup();
    deps.callSigner.mockRejectedValue(new Error("private upstream message"));
    try {
      const result = await send();
      expect(result.statusCode).toBe(503);
      expect(result.body).not.toContain("private upstream message");
      expect(deps.callSigner).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it("preserves unresolved outcomes", async () => {
    const { app, deps, send } = setup();
    deps.callSigner.mockResolvedValue({ ok: true, status: 200, json: { status: "reconciled", reconciliation_required: true } });
    try { expect((await send()).json().reconciliation_required).toBe(true); }
    finally { await app.close(); }
  });
  it("requires a complete signer response", async () => {
    const { app, deps, send } = setup();
    deps.callSigner.mockResolvedValue({ ok: true, status: 200, json: { status: "reconciled" } });
    try { expect((await send()).statusCode).toBe(503); }
    finally { await app.close(); }
  });
});


describe("owned native recovery reads",()=>{
 it.each(["positions","owner-recovery","owner-recovery-status"])("rejects injected authority at %s",async(kind)=>{const {app,deps}=setup();try{
  const body=kind==="positions"?input:kind==="owner-recovery"?{...input,symbol:"BTC-USDC",slippage_bps:100}:{...input,symbol:"BTC-USDC",phase:"close_position",tx_hash:`0x${"ab".repeat(32)}`,calldata_hash:`0x${"cd".repeat(32)}`};
  expect((await app.inject({method:"POST",url:`/v1/synfutures/${kind}`,headers:{authorization:"Bearer verified"},payload:{...body,user_id:"other",private_key:"secret"}})).statusCode).toBe(400);expect(deps.callSigner).not.toHaveBeenCalled();
 }finally{await app.close();}});
 it("binds receipt scope and strips private upstream fields",async()=>{const {app,deps}=setup();deps.callSigner.mockResolvedValue({ok:true,status:200,json:{status:"mined",phase:"close_position",reconciliation_required:false,private_key:"secret"}});
 try{const payload={...input,symbol:"BTC-USDC",phase:"close_position",tx_hash:`0x${"ab".repeat(32)}`,calldata_hash:`0x${"cd".repeat(32)}`};
  const response=await app.inject({method:"POST",url:"/v1/synfutures/owner-recovery-status",headers:{authorization:"Bearer verified"},payload});expect(response.statusCode).toBe(200);expect(response.body).not.toContain("secret");
  expect(deps.callSigner).toHaveBeenCalledWith("/v1/synfutures/owner-recovery-status",{user_id:"owner",exchange_connection_id:input.connection_id,symbol:payload.symbol,phase:payload.phase,tx_hash:payload.tx_hash,calldata_hash:payload.calldata_hash});
 }finally{await app.close();}});
 it.each(["positions","owner-recovery"])("never converts an unreadable %s into successful protection",async(kind)=>{const {app}=setup();try{
  const payload=kind==="positions"?input:{...input,symbol:"BTC-USDC",slippage_bps:100};const response=await app.inject({method:"POST",url:`/v1/synfutures/${kind}`,headers:{authorization:"Bearer verified"},payload});expect(response.statusCode).toBe(503);
 }finally{await app.close();}});
});
