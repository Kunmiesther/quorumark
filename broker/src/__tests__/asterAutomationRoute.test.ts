import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { build } from "../server";
import { computeWorkerHmac } from "../workerAuth";

const path = "/v1/automation/orders";
const input = {
  user_id: "00000000-0000-4000-8000-000000000001",
  connection_id: "00000000-0000-4000-8000-000000000002",
  venue: "aster", symbol: "ETH-USDT", side: "BUY", order_type: "MARKET",
  campaign_rung_count: 5, leverage: 125, purpose: "CREATE_ORDER",
  idempotency_key: "decision-12345678", is_live: true,
};
beforeEach(() => {
  for (const [key, value] of Object.entries({
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test-key",
    SIGNER_BASE_URL: "https://signer.test", SIGNER_SHARED_SECRET: "signer-test",
    WORKER_ORDER_SHARED_SECRET: "worker-test", ASTER_MAINNET_AUTOMATION_ENABLED: "true",
    NODE_ENV: "test",
  })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function send(body: Record<string, unknown>, response: Response) {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetch);
  const app = await build();
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("hex");
  try {
    const result = await app.inject({ method: "POST", url: path, payload: body,
      headers: { "x-worker-timestamp": timestamp, "x-worker-nonce": nonce,
        "x-worker-signature": computeWorkerHmac("worker-test", timestamp, nonce, path, body) } });
    return { result, fetch };
  } finally { await app.close(); }
}

describe("Aster worker → broker → signer contract", () => {
  it.each([{}, {ok:true,aster_automation_enabled:false}, {ok:false,aster_automation_enabled:true}])("does not advertise Aster from incomplete signer readiness: %j", async health => {
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(health)));
    const app=await build();
    try {
      const response=await app.inject({method:"GET",url:"/v1/automation/capabilities"});
      expect(response.json()).toMatchObject({accepting_orders:false,venues:{aster:false,apex_omni:false},supported_campaign_rung_counts:[]});
    } finally {await app.close();}
  });
  it("does not advertise any route when the signer is unreachable",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("unreachable");}));
    const app=await build();
    try {
      expect((await app.inject({method:"GET",url:"/v1/automation/capabilities"})).json()).toMatchObject({accepting_orders:false,signer_reachable:false});
    } finally {await app.close();}
  });
  it("accepts exact Python JSON bytes at the HTTP boundary and rejects tampering/replay", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "submitted" }));
    vi.stubGlobal("fetch", fetch);
    const app = await build();
    const raw = JSON.stringify(input).replace('"leverage":125', '"leverage":125.0');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const signature = createHmac("sha256", "worker-test")
      .update(`${timestamp}\n${nonce}\n${path}\n${raw}`).digest("hex");
    const headers = { "content-type": "application/json", "x-worker-timestamp": timestamp,
      "x-worker-nonce": nonce, "x-worker-signature": signature, "x-worker-signature-version": "raw-v1" };
    try {
      const tampered = await app.inject({ method: "POST", url: path, headers, payload: raw.replace("125.0", "100.0") });
      expect(tampered.statusCode).toBe(401);
      expect(tampered.json().reject_reason).toBe("INVALID_AUTOMATION_SIGNATURE");
      expect(fetch).not.toHaveBeenCalled();
      const accepted = await app.inject({ method: "POST", url: path, headers, payload: raw });
      expect(accepted.statusCode).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(1);
      const replayed = await app.inject({ method: "POST", url: path, headers, payload: raw });
      expect(replayed.json().reject_reason).toBe("AUTOMATION_REPLAY");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it("reports Aster independently of ApeX entry flags", async () => {
    for (const name of ["APEX_MAINNET_SIGNER_ENABLED", "APEX_MAINNET_CANARY_ENABLED", "APEX_MAINNET_AUTOMATION_ENABLED"]) vi.stubEnv(name, "false");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ok:true,aster_automation_enabled:true})));
    const app = await build();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/automation/capabilities" });
      expect(response.json()).toMatchObject({venues:{apex_omni:false,aster:true},accepting_orders:true,supported_campaign_rung_counts:[5]});
    } finally { await app.close(); }
  });
  it.each([true, false, undefined])("reports signer Aster readiness without assuming enabled: %s", async enabled => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, aster_automation_enabled: enabled })));
    const app = await build();
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      expect(response.json().aster_automation_enabled).toBe(enabled === true);
    } finally { await app.close(); }
  });
  it("preserves Aster identity and delegates sizing rather than translating to ApeX", async () => {
    const { result, fetch } = await send(input, Response.json({ status: "submitted", campaign_rung_count: 5 }));
    expect(result.statusCode).toBe(200);
    const payload = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(payload).toMatchObject({ venue: "aster", exchange_connection_id: input.connection_id,
      purpose: "AUTOMATED_ENTRY", leverage: 125, size: null });
  });
  it("keeps reduce-only exits available when new entries are paused", async () => {
    vi.stubEnv("ASTER_MAINNET_AUTOMATION_ENABLED", "false");
    const { campaign_rung_count, leverage, ...base } = input;
    const { result, fetch } = await send({ ...base, reduce_only: true, side: "SELL", size: 0.01 },
      Response.json({ status: "submitted", exchange_status: "partially_filled", filled_size: "0.003", reduce_only: true, reconciliation_required: true }));
    expect(result.json()).toMatchObject({ reconciliation_required: true, filled_size: "0.003", reduce_only: true });
    const payload = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(payload.purpose).toBe("CLOSE_POSITION");
  });
  it.each([{}, { status: "unexpected" }])("does not report a malformed response as submitted", async response => {
    const { result } = await send(input, Response.json(response));
    expect(result.statusCode).toBe(502);
    expect(result.json().status).toBe("ambiguous");
  });
  it("keeps upstream 5xx uncertain", async () => {
    const { result } = await send(input, Response.json({ detail: "UPSTREAM_ERROR" }, { status: 503 }));
    expect(result.json().status).toBe("ambiguous");
  });
});
