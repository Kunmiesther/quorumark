import { describe, expect, it } from "vitest";
import {
  PAPER_PORTFOLIO_WALLETS,
  PAPER_WALLET_SEED_USD,
  paperWalletFunds,
  paperTicketAvailable,
} from "./portfolioWallets";
describe("six paper wallet portfolio", () => {
  it("limits a manual ticket to its own wallet, not the whole portfolio", () => {
    expect(paperTicketAvailable(15000, 2500, 125)).toBe(2375);
    expect(paperTicketAvailable(500, 2500, 125)).toBe(500);
    expect(paperTicketAvailable(15000, null, 0)).toBeNull();
  });
  it("preserves four trading roles and separates the two chain families", () => {
    expect(PAPER_PORTFOLIO_WALLETS.map((w) => w.key)).toEqual([
      "long",
      "short",
      "hedge",
      "strategy",
      "blockchain_evm",
      "blockchain_non_evm",
    ]);
    expect(PAPER_PORTFOLIO_WALLETS.length * PAPER_WALLET_SEED_USD).toBe(15000);
  });
  it("reports held collateral without inventing funds", () => {
    expect(paperWalletFunds(2500, 125)).toEqual({ settled: 2500, reserved: 125, available: 2375 });
    expect(paperWalletFunds(100, 150)?.available).toBe(0);
    expect(paperWalletFunds(null, 0)).toBeNull();
    expect(paperWalletFunds(Infinity, 0)).toBeNull();
  });
});
