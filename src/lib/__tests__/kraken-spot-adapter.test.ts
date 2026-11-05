import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KrakenSpotAdapter,
  krakenSpotSign,
} from "../../../supabase/functions/_shared/exchange-adapter";

const creds = {
  apiKey: "public-key",
  apiSecret: "a1FIX1cvOHAxVFY5NDF1MUdPVmo2Y1dBanpCQ29TVVhOc3UzZW93NzZzejg0UTE4Zld4bnlSekJIQ2QzcGQ1bkU5cWE5OUhBWnR1WnVqNkYxaHVYZz09",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Kraken Spot adapter", () => {
  it("matches Kraken's published REST signature vector", async () => {
    const signature = await krakenSpotSign({
      path: "/0/private/AddOrder",
      nonce: "1616492376594",
      formBody: "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25",
      apiSecret:
        "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==",
    });
    expect(signature).toBe(
      "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==",
    );
  });

  it("verifies a read-only key and checks the Balance endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ result: { status: "online" }, error: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ result: { permissions: ["query-funds"] }, error: [] }),
      )
      .mockResolvedValueOnce(jsonResponse({ result: { ZUSD: "25.00" }, error: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new KrakenSpotAdapter();
    expect((await adapter.healthCheck()).ok).toBe(true);
    const result = await adapter.validateCredentials(creds);

    expect(result).toEqual({
      ok: true,
      data: {
        verified: true,
        permissions: { read: true, trade: false, withdraw: false },
      },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.kraken.com/0/public/SystemStatus",
      "https://api.kraken.com/0/private/GetApiKeyInfo",
      "https://api.kraken.com/0/private/Balance",
    ]);
  });

  it("rejects a key with any withdrawal permission before reading balances", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        result: { permissions: ["query-funds", "withdraw-funds"] },
        error: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new KrakenSpotAdapter().validateCredentials(creds);

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
