/**
 * Paper-tick endpoint security contract tests.
 *
 * These tests import the ROUTE MODULE directly and invoke its POST handler
 * with hand-crafted Request objects. They validate:
 *   - anon/publishable keys are rejected
 *   - missing PAPER_TICK_CRON_SECRET fails closed
 *   - wrong bearer is rejected
 *   - response cannot leak user_id or internal error text
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadRoute() {
  vi.resetModules();
  // Stub the admin client and engine so the handler can run without a DB.
  vi.doMock("@/integrations/supabase/client.server", () => {
    const supabaseAdmin = {
      from: (_table: string) => ({
        select: () => ({
          eq: () => Promise.resolve({ data: [{ user_id: "USER-SECRET-ID" }], error: null }),
          in: () =>
            Promise.resolve({
              data: [{ user_id: "USER-SECRET-ID", last_tick_at: null }],
              error: null,
            }),
        }),
      }),
      rpc: (_fn: string, _args: unknown) => Promise.resolve({ data: true, error: null }),
    };
    return { supabaseAdmin };
  });
  vi.doMock("@/lib/paper/engine", () => ({
    runPaperTick: () => {
      throw new Error("INTERNAL-SECRET-STACKTRACE::db://password@host");
    },
  }));
  const mod = await import("../paper-tick");
  const handlers = (
    mod.Route as unknown as {
      options: {
        server: {
          handlers: {
            GET: (ctx: { request: Request }) => Promise<Response>;
            POST: (ctx: { request: Request }) => Promise<Response>;
          };
        };
      };
    }
  ).options.server.handlers;
  return handlers;
}

function req(headers: Record<string, string>): Request {
  return new Request("http://x/api/public/hooks/paper-tick", {
    method: "POST",
    headers,
    body: "{}",
  });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, PAPER_TICK_CRON_SECRET: "correct-secret-xyz" };
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.doUnmock("@/integrations/supabase/client.server");
  vi.doUnmock("@/lib/paper/engine");
});

describe("paper-tick endpoint auth", () => {
  it("rejects requests with no Authorization header", { timeout: 30_000 }, async () => {
    const { POST } = await loadRoute();
    const res = await POST({ request: req({}) });
    expect(res.status).toBe(401);
  });

  it("rejects requests using the anon/publishable key as apikey header", async () => {
    const { POST } = await loadRoute();
    const res = await POST({
      request: req({ apikey: "sb_publishable_QCSYB0HenKbsXbEXS2rK-Q_JfbaAP4w" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong bearer token", async () => {
    const { POST } = await loadRoute();
    const res = await POST({ request: req({ authorization: "Bearer WRONG" }) });
    expect(res.status).toBe(401);
  });

  it("fails closed when PAPER_TICK_CRON_SECRET is missing", async () => {
    delete process.env.PAPER_TICK_CRON_SECRET;
    delete process.env.CRON_SECRET;
    const { POST } = await loadRoute();
    const res = await POST({ request: req({ authorization: "Bearer anything" }) });
    expect(res.status).toBe(401);
  });

  it("accepts a correct bearer and returns a sanitized body (no user_id / no error text)", async () => {
    const { POST } = await loadRoute();
    const res = await POST({
      request: req({ authorization: "Bearer correct-secret-xyz" }),
    });
    expect([200, 500]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("USER-SECRET-ID");
    expect(text).not.toContain("INTERNAL-SECRET-STACKTRACE");
    expect(text).not.toContain("password");
    const body = JSON.parse(text) as Record<string, unknown>;
    // Only the bounded aggregate keys are allowed on the response. The
    // agentic sweep counters are counts of rows touched this tick — they
    // name no user, symbol, position or error, so they belong here; the
    // point of the allowlist is that nothing per-tenant leaks, not that
    // the tick may never report new totals.
    const allowed = new Set([
      "ok",
      "processed",
      "succeeded",
      "failed",
      "durationMs",
      "managedPositions",
      "managementEvents",
      "tradesReviewed",
      "sweepErrors",
    ]);
    for (const key of Object.keys(body)) expect(allowed.has(key), key).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts Vercel cron GET requests authenticated by CRON_SECRET", async () => {
    delete process.env.PAPER_TICK_CRON_SECRET;
    process.env.CRON_SECRET = "vercel-cron-secret";
    const { GET } = await loadRoute();
    const res = await GET({
      request: new Request("http://x/api/public/hooks/paper-tick", {
        headers: { authorization: "Bearer vercel-cron-secret" },
      }),
    });
    expect([200, 500]).toContain(res.status);
  });

  it("accepts Vercel CRON_SECRET when the dedicated paper secret is also configured", async () => {
    process.env.PAPER_TICK_CRON_SECRET = "manual-paper-secret";
    process.env.CRON_SECRET = "vercel-cron-secret";
    const { GET } = await loadRoute();
    const res = await GET({
      request: new Request("http://x/api/public/hooks/paper-tick", {
        headers: { authorization: "Bearer vercel-cron-secret" },
      }),
    });
    expect([200, 500]).toContain(res.status);
  });
});
