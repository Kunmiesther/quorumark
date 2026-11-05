import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BlockchainNetworks } from "../trust/BlockchainNetworks";
import { SynFuturesQuotePanel } from "../trust/SynFuturesQuotePanel";
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/blockchain/readiness.functions", () => ({ inspectBlockchainWallet: vi.fn() }));
vi.mock("@/lib/exchanges/synfutures.functions", () => ({ inspectSynFuturesQuote: vi.fn() }));
vi.mock("@/components/wallet/AddWalletModal", () => ({ AddWalletModal: () => null }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ reset: vi.fn(), mutate: vi.fn(), isPending: false }),
}));
afterEach(cleanup);
const wallets = [
  {
    id: "wallet",
    provider: "metamask",
    label: null,
    public_address: "0x123456789012345678901234567890123456abcd",
    chain: "ethereum",
    network: "mainnet",
    status: "verified",
    is_active: true,
  },
];
describe("blockchain network choices", () => {
  it("shows four networks, offers an EVM wallet only on compatible networks and never arms trading", () => {
    render(<BlockchainNetworks wallets={wallets} />);
    expect(screen.getAllByRole("article")).toHaveLength(4);
    const base = screen.getByLabelText("Wallet for Base") as HTMLSelectElement;
    const solana = screen.getByLabelText("Wallet for Solana") as HTMLSelectElement;
    expect(base.options).toHaveLength(2);
    expect(solana.options).toHaveLength(1);
    expect(screen.getByLabelText("Wallet for Robinhood Chain")).toBeTruthy();
    fireEvent.change(base, { target: { value: "wallet" } });
    expect(
      (screen.getAllByRole("button", { name: "Check network" })[0] as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole("button", { name: /arm|trade|approve/i })).toBeNull();
  });
  it("uses unique IDs in desktop and mobile instances", () => {
    render(
      <>
        <BlockchainNetworks wallets={wallets} />
        <BlockchainNetworks wallets={wallets} />
      </>,
    );
    const selectors = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(new Set(selectors.map((s) => s.id)).size).toBe(8);
  });
  it("does not claim wallets are absent when loading failed", () => {
    render(<BlockchainNetworks wallets={[]} isError />);
    expect(screen.getByRole("alert").textContent).toContain("Wallet list unavailable");
    expect(screen.queryByText("No compatible verified wallet yet.")).toBeNull();
  });
});
describe("SynFutures quote controls", () => {
  it("requires a chosen market and valid positive amount, with no order submission", () => {
    render(
      <SynFuturesQuotePanel
        markets={[{ instrument: "0x1", symbol: "BTC-USDC", expiries: [4294967295] }]}
      />,
    );
    const button = screen.getByRole("button", { name: "Get on-chain quote" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Market / expiry"), {
      target: { value: "0x1:4294967295" },
    });
    expect(button.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Notional (quote-token units)"), {
      target: { value: "-10" },
    });
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /submit|execute|approve/i })).toBeNull();
  });
});
