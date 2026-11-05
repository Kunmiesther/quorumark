import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createAuthCacheHandler } from "./auth-cache";
describe("auth cache identity", () => {
  it("keeps existing account queries when focus reconfirms the same user", () => {
    const client = new QueryClient(), router = { invalidate: vi.fn() };
    const handle = createAuthCacheHandler(client, router);
    handle("INITIAL_SESSION", "owner");
    client.setQueryData(["synfutures-account-registration", "owner"], { safe: "saved" });
    handle("SIGNED_IN", "owner");
    handle("SIGNED_IN", "owner");
    expect(client.getQueryData(["synfutures-account-registration", "owner"])).toEqual({ safe: "saved" });
    expect(router.invalidate).not.toHaveBeenCalled();
  });
  it("clears previous account data before switching users", () => {
    const client = new QueryClient(), router = { invalidate: vi.fn() };
    const handle = createAuthCacheHandler(client, router);
    handle("INITIAL_SESSION", "owner");
    client.setQueryData(["private-account"], "owner balance");
    handle("SIGNED_IN", "different-user");
    expect(client.getQueryData(["private-account"])).toBeUndefined();
    expect(router.invalidate).toHaveBeenCalledOnce();
  });
  it("clears private queries on sign-out and on first sign-in without an initial session", () => {
    const client = new QueryClient(), router = { invalidate: vi.fn() };
    const handle = createAuthCacheHandler(client, router);
    client.setQueryData(["private-account"], "stale");
    handle("SIGNED_IN", "owner");
    expect(client.getQueryData(["private-account"])).toBeUndefined();
    client.setQueryData(["private-account"], "owner balance");
    handle("SIGNED_OUT", null);
    expect(client.getQueryData(["private-account"])).toBeUndefined();
  });
  it("preserves queries during token refresh but refreshes changed user metadata", () => {
    const client = new QueryClient(), router = { invalidate: vi.fn() };
    const handle = createAuthCacheHandler(client, router);
    handle("INITIAL_SESSION", "owner");
    client.setQueryData(["private-account"], "owner balance");
    handle("TOKEN_REFRESHED", "owner");
    expect(router.invalidate).not.toHaveBeenCalled();
    handle("USER_UPDATED", "owner");
    expect(client.getQueryData(["private-account"])).toBe("owner balance");
    expect(router.invalidate).toHaveBeenCalledOnce();
  });
});
