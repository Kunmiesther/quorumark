import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlockchainSpotPanel } from "../trust/BlockchainSpotPanel";
import { testWallet } from "@/lib/blockchain/transactions.fixtures";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), preview: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "test-only" } } }) },
  },
}));
vi.mock("@/lib/blockchain/spot.functions", () => ({
  inspectBlockchainToken: mocks.inspect,
  inspectSpotSwap: mocks.preview,
}));
vi.mock("../trust/BlockchainSwapExecution", () => ({
  BlockchainSwapExecution: ({ valid }: { valid: boolean }) => (
    <button disabled={!valid}>Prepare wallet review</button>
  ),
}));
const address = "0x4444444444444444444444444444444444444444";
const token = { address, chainId: 8453, decimals: 18, symbol: "NEW" };
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/exchanges");
  mocks.inspect.mockResolvedValue(token);
});
afterEach(cleanup);
function setup() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <BlockchainSpotPanel network="base" wallet={testWallet} />
    </QueryClientProvider>,
  );
}
function choose() {
  fireEvent.change(screen.getByLabelText("Token selection"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("Token contract on Base"), { target: { value: address } });
}
describe("custom token swap form", () => {
  it("carries a discovery address but never reads or prepares a swap automatically", () => {
    window.history.replaceState(null, "", `/exchanges?swapNetwork=base&swapToken=${address}`);
    setup();
    expect((screen.getByLabelText("Token contract on Base") as HTMLInputElement).value).toBe(
      address,
    );
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Prepare wallet review" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("requires on-chain metadata before preview and invalidates selection when address changes", async () => {
    setup();
    choose();
    fireEvent.change(screen.getByLabelText("Amount to sell (ETH)"), { target: { value: "0.01" } });
    expect(
      (screen.getByRole("button", { name: "Preview swap & check wallet" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Inspect token contract" }));
    await screen.findByText(/NEW · 18 decimals/);
    fireEvent.click(screen.getByRole("button", { name: "Preview swap & check wallet" }));
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    expect(mocks.preview.mock.calls[0][0].data).toMatchObject({
      token,
      network: "base",
      amount: "0.01",
    });
    fireEvent.change(screen.getByLabelText("Token contract on Base"), {
      target: { value: "0x5555555555555555555555555555555555555555" },
    });
    expect(screen.queryByText(/NEW · 18 decimals/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Prepare wallet review" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("discards token metadata that arrives after the address changes", async () => {
    let resolve!: (value: typeof token) => void;
    mocks.inspect.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    setup();
    choose();
    fireEvent.click(screen.getByRole("button", { name: "Inspect token contract" }));
    await waitFor(() => expect(mocks.inspect).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Token contract on Base"), {
      target: { value: "0x5555555555555555555555555555555555555555" },
    });
    await act(async () => resolve(token));
    expect(screen.queryByText(/NEW · 18 decimals/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Prepare wallet review" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
