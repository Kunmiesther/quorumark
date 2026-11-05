import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ExchangeIdentity, WalletIdentity } from "../ConnectionIdentity";
import { walletLogo } from "@/lib/wallet-logos";

afterEach(cleanup);

describe("Exchange and wallet identity", () => {
  it.each([
    ["aster", "Aster"],
    ["apex_omni", "ApeX Omni"],
    ["synfutures", "SynFutures"],
  ])("identifies %s even with a custom account label", (exchange, label) => {
    const { container } = render(
      <ExchangeIdentity
        exchange={exchange}
        name="Trading account"
        connectionId="54d5451e-45c7-4122-9bf9-ed1c313d8d31"
      />,
    );
    expect(screen.getByText(`${label} · Trading account`)).toBeTruthy();
    expect(screen.getByText("Account 54d5451e…")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBeTruthy();
  });

  it("shows provider, nickname, address and connection status together", () => {
    const { container } = render(
      <WalletIdentity
        wallet={{
          id: "wallet-1",
          provider: "metamask",
          label: "Strategy funds",
          public_address: "0x123456789012345678901234567890123456abcd",
          status: "connected",
        }}
      />,
    );
    expect(screen.getByText("MetaMask · Strategy funds")).toBeTruthy();
    expect(screen.getByText("0x1234…abcd · connected")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(walletLogo("metamask"));
  });

  it("never substitutes a wallet brand or address when the assignment is missing", () => {
    const { container } = render(<WalletIdentity />);
    expect(screen.getByText("No wallet assigned")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not present an inactive wallet as connected", () => {
    render(
      <WalletIdentity
        wallet={{
          id: "wallet-1",
          provider: "coinbase",
          label: null,
          public_address: "0x1234",
          status: "connected",
          is_active: false,
        }}
      />,
    );
    expect(screen.getByText("Coinbase Wallet")).toBeTruthy();
    expect(screen.getByText("0x1234 · inactive")).toBeTruthy();
  });
});
