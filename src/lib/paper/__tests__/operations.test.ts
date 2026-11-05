import { describe, expect, it, vi } from "vitest";
import {
  claimEngineOperation,
  completeEngineOperation,
  fingerprintPayload,
  sanitizeError,
} from "../operations";
import type { SupabaseClient } from "@supabase/supabase-js";

function mkClient(
  rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
): SupabaseClient {
  return { rpc: (fn: string, args: Record<string, unknown>) => rpcImpl(fn, args) } as unknown as SupabaseClient;
}

describe("claimEngineOperation", () => {
  it("returns claimed for the first caller", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ status: "claimed", result: null }],
      error: null,
    });
    const out = await claimEngineOperation(mkClient(rpc), "u1", "op1", "fp1");
    expect(out.status).toBe("claimed");
    expect(rpc).toHaveBeenCalledWith("claim_paper_engine_operation", {
      _user_id: "u1",
      _op_key: "op1",
      _fingerprint: "fp1",
    });
  });

  it("returns replayed with the prior stored result on identical fingerprint", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ status: "replayed", result: { ok: true, filled: 2 } }],
      error: null,
    });
    const out = await claimEngineOperation(mkClient(rpc), "u1", "op1", "fp1");
    expect(out.status).toBe("replayed");
    if (out.status === "replayed") expect(out.result).toEqual({ ok: true, filled: 2 });
  });

  it("returns conflict when fingerprint differs from stored", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ status: "conflict", result: null }],
      error: null,
    });
    const out = await claimEngineOperation(mkClient(rpc), "u1", "op1", "fp-DIFFERENT");
    expect(out.status).toBe("conflict");
  });

  it("fails closed with error on any DB error (unique or otherwise)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });
    const out = await claimEngineOperation(mkClient(rpc), "u1", "op1", "fp1");
    expect(out.status).toBe("error");
    if (out.status === "error") expect(out.reason).toBe("internal");
  });

  it("fails closed on thrown RPC exception (never leaks the message)", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("PGRST-INTERNAL::password=secret"));
    const out = await claimEngineOperation(mkClient(rpc), "u1", "op1", "fp1");
    expect(out.status).toBe("error");
    expect(JSON.stringify(out)).not.toContain("password");
    expect(JSON.stringify(out)).not.toContain("PGRST-INTERNAL");
  });

  it("concurrent claims yield exactly one owner (single claimed among many)", async () => {
    let firstServed = false;
    const rpc = vi.fn().mockImplementation(async () => {
      if (!firstServed) {
        firstServed = true;
        return { data: [{ status: "claimed", result: null }], error: null };
      }
      return { data: [{ status: "replayed", result: { ok: true } }], error: null };
    });
    const client = mkClient(rpc);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimEngineOperation(client, "u1", "op1", "fp1")),
    );
    const owners = results.filter((r) => r.status === "claimed");
    expect(owners.length).toBe(1);
    for (const r of results) {
      expect(["claimed", "replayed"]).toContain(r.status);
    }
  });
});

describe("completeEngineOperation", () => {
  it("returns ok on success", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const out = await completeEngineOperation(mkClient(rpc), "u1", "op1", { done: true });
    expect(out).toEqual({ ok: true, value: true });
  });

  it("sanitizes internal errors", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied for other user" },
    });
    const out = await completeEngineOperation(mkClient(rpc), "u1", "op1", {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("internal");
    expect(JSON.stringify(out)).not.toContain("permission denied");
  });
});

describe("fingerprintPayload", () => {
  it("is stable across key order", async () => {
    const a = await fingerprintPayload({ a: 1, b: [2, 3], c: { d: 4 } });
    const b = await fingerprintPayload({ c: { d: 4 }, b: [2, 3], a: 1 });
    expect(a).toBe(b);
  });
  it("changes when payload changes", async () => {
    const a = await fingerprintPayload({ a: 1 });
    const b = await fingerprintPayload({ a: 2 });
    expect(a).not.toBe(b);
  });
});

describe("sanitizeError", () => {
  it("produces a typed failure with no ambient error text", () => {
    const r = sanitizeError<number>("timeout");
    expect(r).toEqual({ ok: false, reason: "timeout" });
  });
});
