// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readTokenSecurity, tokenSecurityBlockers } from "./tokenSecurity.server";
import { clearTokenReport } from "./tokenSecurity.fixtures";

describe("new token entry evidence", () => {
  it("accepts complete cleared evidence without claiming future liquidity", () => {
    expect(tokenSecurityBlockers(clearTokenReport)).toEqual([]);
  });
  it.each(Object.keys(clearTokenReport))("fails closed on missing %s", (key) => {
    const report: Record<string, unknown> = { ...clearTokenReport };
    delete report[key];
    expect(tokenSecurityBlockers(report).length).toBeGreaterThan(0);
  });
  it.each([
    "is_honeypot",
    "cannot_sell_all",
    "transfer_pausable",
    "is_blacklisted",
    "slippage_modifiable",
  ])("rejects flagged %s", (key) => {
    expect(tokenSecurityBlockers({ ...clearTokenReport, [key]: "1" }).join()).toContain(key);
  });
  it.each(["", "NaN", "0.01", null, 0])(
    "does not treat unsupported or unknown sell tax as zero: %s",
    (sell_tax) => {
      expect(tokenSecurityBlockers({ ...clearTokenReport, sell_tax }).join()).toContain("sell_tax");
    },
  );
  it("requires the exact chain and contract response", async () => {
    const address = "0x4444444444444444444444444444444444444444";
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 1, result: { [address]: clearTokenReport } })),
    );
    expect(await readTokenSecurity(8453, address, fetcher)).toEqual(clearTokenReport);
    expect(fetcher.mock.calls[0][0]).toContain(`/8453?contract_addresses=${address}`);
    expect(
      await readTokenSecurity(
        56,
        address,
        async () => new Response(JSON.stringify({ code: 1, result: {} })),
      ),
    ).toBeNull();
    expect(await readTokenSecurity(1, address, fetcher)).toBeNull();
  });
  it("handles rate limits and malformed responses as unknown", async () => {
    const address = "0x4444444444444444444444444444444444444444";
    expect(
      await readTokenSecurity(8453, address, async () => new Response("busy", { status: 429 })),
    ).toBeNull();
    expect(await readTokenSecurity(8453, address, async () => new Response("invalid"))).toBeNull();
  });
});
