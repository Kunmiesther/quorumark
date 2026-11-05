import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_TEST_DEFAULTS } from "@/lib/app-env";

const source = readFileSync(
  resolve(process.cwd(), "src/components/trade/ManualTradeTicket.tsx"),
  "utf8",
);
const liveTicket = source.slice(source.indexOf("function LiveTestTicket"));
const tradeDesk = readFileSync(
  resolve(process.cwd(), "src/components/trade/TradeDesk.tsx"),
  "utf8",
);

describe("owner live-test ticket contract", () => {
  it("starts below the server default personal order limit at a representative ETH price", () => {
    expect(LIVE_TEST_DEFAULTS.symbol).toBe("ETH-USDT");
    expect(LIVE_TEST_DEFAULTS.size * 2_500).toBeLessThanOrEqual(LIVE_TEST_DEFAULTS.maxNotionalUsd);
    expect(LIVE_TEST_DEFAULTS.maxNotionalUsd).toBe(100);
  });

  it("keeps the owner canary narrow and requires a two-step real-order review", () => {
    expect(liveTicket).not.toContain('aria-label="Limit price"');
    expect(liveTicket).not.toContain('aria-label="Protections"');
    expect(liveTicket).not.toContain('aria-label="Rungs"');
    expect(liveTicket).toContain("The private signer attaches a protective");
    expect(source).toContain("BTC-USDT");
    expect(source).toContain("XRP-USDT");
    expect(liveTicket).toContain("Review live order");
    expect(liveTicket).toContain("Confirm and send real order");
    expect(tradeDesk).toContain('book === "live" && LIVE_TEST_MODE');
  });
});
