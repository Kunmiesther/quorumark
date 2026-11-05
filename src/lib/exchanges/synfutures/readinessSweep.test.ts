// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("./account.server", () => ({ inspectSynFuturesAccount: vi.fn() }));
import { runSynFuturesReadinessSweep } from "./readinessSweep.server";
const registration = { user_id: "owner", wallet_id: "wallet", owner_address: "0x1111", safe_address: "0x2222", module_address: "0x3333" };
function database(owner = "0x1111") {
  const filters: unknown[][] = [];
  const insert = vi.fn().mockResolvedValue({ error: null });
  const db = { from: vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "limit"]) q[method] = (...args: unknown[]) => { if (method === "eq") filters.push(args); return q; };
    q.maybeSingle = () => Promise.resolve({ data: { public_address: owner }, error: null });
    q.then = (resolve: (v: unknown) => void) => resolve({ data: [registration], error: null });
    q.insert = insert;
    return q;
  }) };
  return { db, filters, insert };
}
const account = { address: "0x2222", module: "0x3333", observed_block: "123", execution_ready: false,
  readiness: { blockers: ["OPERATOR_NOT_AUTHORIZED"], execution_ready: false } };
describe("autonomous SynFutures observations", () => {
  it("observes a registered owned account and persists blockers without activation", async () => {
    const h = database(), inspect = vi.fn().mockResolvedValue(account);
    const out = await runSynFuturesReadinessSweep(h.db as never, inspect);
    expect(out).toEqual({ scanned: 1, observed: 1, blocked: 1, failed: 0 });
    expect(h.filters).toContainEqual(["user_id", "owner"]);
    expect(inspect).toHaveBeenCalledWith("0x1111", "wallet");
    expect(h.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: "owner", event: "SYNFUTURES_READINESS_OBSERVED",
      detail: expect.objectContaining({ execution_ready: false, blockers: ["OPERATOR_NOT_AUTHORIZED"] }) }));
  });
  it("does not inspect a mismatched wallet", async () => {
    const h = database("0x9999"), inspect = vi.fn();
    expect((await runSynFuturesReadinessSweep(h.db as never, inspect)).failed).toBe(1);
    expect(inspect).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("does not persist a result for a different Safe", async () => {
    const h = database(), inspect = vi.fn().mockResolvedValue({ ...account, address: "0x9999" });
    expect((await runSynFuturesReadinessSweep(h.db as never, inspect)).failed).toBe(1);
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("reports an audit persistence failure instead of claiming success", async () => {
    const h = database(), inspect = vi.fn().mockResolvedValue(account);
    h.insert.mockResolvedValue({ error: { code: "failure" } });
    expect((await runSynFuturesReadinessSweep(h.db as never, inspect)).observed).toBe(0);
  });
});
