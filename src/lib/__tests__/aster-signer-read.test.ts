import { describe, it, expect, vi } from "vitest";
import { readAster, asterPositions, asterEquity, asterFills, asterReadFailure } from "../../../supabase/functions/_shared/aster-signer-read";

const conn = { id: "connection-A", user_id: "owner", exchange: "aster", environment: "mainnet" };
const response = { status: "ok", exchange: "aster", environment: "mainnet", connection_id: conn.id };
const opts = { baseUrl: "https://signer.test", secret: "test-secret" };

describe("Aster read transport", () => {
  it.each(["ASTER_SNAPSHOT_INVALID_SYMBOL", "ASTER_2015"])("preserves the stable diagnostic %s", async code => {
    try {
      await readAster(conn, "positions", {}, { ...opts, fetchImpl: async () => Response.json({ detail: code }, { status: 502 }) });
      throw new Error("expected failure");
    } catch (error) {
      expect(asterReadFailure(error, "FAILED")).toBe(code);
    }
  });
  it.each(["secret wallet detail", { private_key: "secret" }, "ASTER_SECRET_PRIVATE_KEY"])("does not echo unknown upstream details", async detail => {
    await expect(readAster(conn, "positions", {}, { ...opts,
      fetchImpl: async () => Response.json({ detail }, { status: 502 }) })).rejects.toThrow("ASTER_READ_HTTP_502");
    expect(asterReadFailure(new Error("private upstream information"), "FAILED")).toBe("FAILED");
  });
  it("signs only the selected connection read", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response)));
    await readAster(conn, "equity", {}, { ...opts, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://signer.test/v1/aster/equity");
    expect(JSON.parse(init.body as string)).toEqual({ user_id: "owner", exchange_connection_id: conn.id });
    expect((init.headers as Record<string, string>)["x-signer-signature"]).toMatch(/^[a-f0-9]{64}$/);
    expect(init.body).not.toContain("test-secret");
  });
  it("refuses an ApeX connection before sending", async () => {
    const fetchImpl = vi.fn();
    await expect(readAster({ ...conn, exchange: "apex_omni" }, "positions", {}, { ...opts, fetchImpl })).rejects.toThrow("MISMATCH");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("maps the stored production environment to the mainnet reader only", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response)));
    await expect(readAster({ ...conn, environment: "production" }, "equity", {}, { ...opts, fetchImpl })).resolves.toEqual(response);
    await expect(readAster({ ...conn, environment: "testnet" }, "equity", {}, { ...opts, fetchImpl })).rejects.toThrow("MISMATCH");
  });
  it.each([{ ...response, connection_id: "other" }, { status: "error" }, null])("rejects unconfirmed snapshot identity", async data => {
    await expect(readAster(conn, "positions", {}, { ...opts, fetchImpl: async () => new Response(JSON.stringify(data)) })).rejects.toThrow();
  });
  it("never turns malformed positions or equity into an empty account", () => {
    expect(() => asterPositions({ positions: [], open_orders: null })).toThrow();
    expect(() => asterEquity({ available_balance: null, total_equity: 10, currency: "USDT" })).toThrow();
    expect(asterEquity({ available_balance: "0", total_equity: "0", currency: "USDT" }).available_balance).toBe(0);
  });
  it("requires complete fill-window evidence", () => {
    expect(() => asterFills({ fills: [] })).toThrow();
    expect(asterFills({ fills: [], complete_through_ms: 100 })).toEqual({ fills: [], completeThrough: 100 });
  });
});
