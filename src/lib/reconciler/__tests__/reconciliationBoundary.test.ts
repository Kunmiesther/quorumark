// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as closes from "../../../../supabase/functions/_shared/live-position-close";
import * as auth from "../../../../supabase/functions/_shared/service-reader-auth";
import * as policy from "../../../../supabase/functions/_shared/venue-read-policy";

function harness(user: unknown = { id: "verified-owner" }, authError: unknown = null) {
  const filters: unknown[][] = [];
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn((...args: unknown[]) => { filters.push(args); return query; }),
    in: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }),
  };
  const db = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: authError }) },
    from: vi.fn().mockReturnValue(query) };
  let handler!: (request: Request) => Promise<Response>;
  const environment: Record<string, string> = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" };
  const deno = { env: { get: (key: string) => environment[key] }, serve: (fn: typeof handler) => { handler = fn; } };
  const code = ts.transpileModule(readFileSync("supabase/functions/reconcile-live-positions/index.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "Deno", "exports", code)((path: string) => {
    if (path.startsWith("https://")) return { createClient: () => db };
    if (path.includes("live-position-close")) return closes;
    if (path.includes("service-reader-auth")) return auth;
    if (path.includes("venue-read-policy")) return policy;
    return {};
  }, deno, {});
  return { handler, db, filters };
}
describe("actual reconciliation request boundary", () => {
  it("rejects unauthenticated requests before enumerating accounts", async () => {
    const h = harness();
    expect((await h.handler(new Request("https://example.test", { method: "POST" }))).status).toBe(401);
    expect(h.db.from).not.toHaveBeenCalled();
  });
  it("does not trust fake service-role claims", async () => {
    const h = harness(null, { message: "invalid" });
    const request = new Request("https://example.test", { headers: { authorization: "Bearer fake-service-claims" } });
    expect((await h.handler(request)).status).toBe(401);
    expect(h.db.from).not.toHaveBeenCalled();
  });
  it("scopes a valid user to server-verified ownership, ignoring a supplied user ID", async () => {
    const h = harness();
    const request = new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer valid-owner-token" },
      body: JSON.stringify({ user_id: "another-owner" }) });
    expect((await h.handler(request)).status).toBe(200);
    expect(h.db.auth.getUser).toHaveBeenCalledWith("valid-owner-token");
    expect(h.filters).toContainEqual(["user_id", "verified-owner"]);
    expect(h.filters).not.toContainEqual(["user_id", "another-owner"]);
  });
  it("allows an exact server credential to run a scheduled sweep without impersonating a user", async () => {
    const h = harness();
    const request = new Request("https://example.test", { headers: { authorization: "Bearer service-key" } });
    expect((await h.handler(request)).status).toBe(200);
    expect(h.db.auth.getUser).not.toHaveBeenCalled();
    expect(h.filters).not.toContainEqual(["user_id", "verified-owner"]);
  });
});
