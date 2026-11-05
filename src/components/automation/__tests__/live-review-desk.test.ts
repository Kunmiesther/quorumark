import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desk = readFileSync(
  join(process.cwd(), "src/components/automation/LiveReviewDesk.tsx"),
  "utf8",
);
const page = readFileSync(join(process.cwd(), "src/routes/_authenticated/automation.tsx"), "utf8");

describe("Autopilot live review desk", () => {
  it("puts live positions ahead of setup", () => {
    expect(page.indexOf("<LiveReviewDesk />")).toBeGreaterThan(0);
    expect(page.indexOf("<LiveReviewDesk />")).toBeLessThan(page.indexOf("<ActivationPath />"));
  });

  it("uses venue positions and persisted Council reviews, not paper rows", () => {
    expect(desk).toContain('.from("positions")');
    expect(desk).toContain('.eq("source", "live")');
    expect(desk).toContain('.from("live_tp_council_reviews")');
    expect(desk).not.toContain('.from("paper_positions")');
  });

  it("covers all four trading symbols and keeps a polling fallback", () => {
    for (const symbol of ["BTC", "ETH", "SOL", "XRP"]) expect(desk).toContain(`"${symbol}"`);
    expect(desk).toContain('table: "positions"');
    expect(desk).toContain('table: "live_tp_council_reviews"');
    expect(desk).toContain("refetchInterval: REFRESH_MS");
  });

  it("does not label an unverified stop or AI opinion as executed protection", () => {
    expect(desk).toContain("Not verified");
    expect(desk).toContain("no order submitted");
    expect(desk).toContain("will not invent it");
  });

  it("identifies each position by venue connection and only names an unambiguous linked wallet", () => {
    expect(desk).toContain(
      "id,connection_id,wallet_connection_id,autopilot_workflow_id,strategy_id,decision_id,exchange,pair,side,size,entry_price",
    );
    expect(desk).toContain('.from("exchange_connections")');
    expect(desk).toContain('.from("wallet_connections")');
    expect(desk).toContain("item.id === position.wallet_connection_id");
    // Account-address matching now lives in the shared resolver (behavioral
    // coverage in accountIdentity.test.ts), not an inline assignment-only filter.
    expect(desk).toContain("connectedWallets(");
    expect(desk).toContain("position.connection_id,");
    expect(desk).toContain("walletIdentities.data ?? []");
    expect(desk).toContain("matchingWallets.length === 1");
    expect(desk).toContain("Multiple wallets linked — unresolved");
    for (const label of ["Symbol", "Entry", "Margin (est.)", "Leverage", "Wallet", "Exchange"]) {
      expect(desk).toContain(`>${label}</dt>`);
    }
  });
});
