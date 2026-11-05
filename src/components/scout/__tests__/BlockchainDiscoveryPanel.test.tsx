import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlockchainDiscoveryPanel } from "../BlockchainDiscoveryPanel";
import { normalizeDiscovery, type DiscoveryResult } from "@/lib/scout/discovery";

const mocks = vi.hoisted(() => ({ discover: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/scout/discovery.functions", () => ({ discoverPools: mocks.discover }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: mocks.session } },
}));
const address = "0x1111111111111111111111111111111111111111";
const result: DiscoveryResult = {
  fetchedAt: 10000,
  pairs: normalizeDiscovery(
    [
      {
        chainId: "base",
        pairAddress: address,
        baseToken: { address, symbol: "TEST", name: "Test" },
        quoteToken: { address, symbol: "USDC", name: "USD" },
        liquidity: { usd: 100 },
        volume: { h24: 100 },
      },
    ],
    "base",
    10000,
  ),
};
function setup() {
  mocks.session.mockResolvedValue({ data: { session: { access_token: "test-only" } } });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <BlockchainDiscoveryPanel />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("blockchain discovery UI", () => {
  it("searches only on request and exposes chain and contract identity", async () => {
    mocks.discover.mockResolvedValue(result);
    setup();
    expect(mocks.discover).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Token contract address or search"), {
      target: { value: "TEST" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find pools" }));
    await screen.findByRole("heading", { name: "TEST / USDC" });
    expect(mocks.discover).toHaveBeenCalledWith({
      data: { chain: "base", query: "TEST" },
      headers: { Authorization: "Bearer test-only" },
    });
    expect(screen.getAllByText(address)).toHaveLength(3);
    expect(screen.getByText(/Contract safety and sellability not checked/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review TEST swap route" }).getAttribute("href")).toBe(
      `/exchanges?swapNetwork=base&swapToken=${address}#blockchain-base`,
    );
    expect(screen.queryByRole("button", { name: /trade|buy|approve/i })).toBeNull();
    fireEvent.change(screen.getByLabelText("Minimum liquidity"), { target: { value: "10000" } });
    expect(screen.queryByRole("heading", { name: "TEST / USDC" })).toBeNull();
    expect(screen.getByText(/No returned pools match/)).toBeTruthy();
  });
  it("does not show an old response after switching chains mid-search", async () => {
    let resolve!: (value: DiscoveryResult) => void;
    mocks.discover.mockImplementation(
      () =>
        new Promise<DiscoveryResult>((r) => {
          resolve = r;
        }),
    );
    setup();
    fireEvent.change(screen.getByLabelText("Token contract address or search"), {
      target: { value: "TEST" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find pools" }));
    await waitFor(() => expect(mocks.discover).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Blockchain"), { target: { value: "solana" } });
    await act(async () => resolve(result));
    expect(screen.queryByRole("heading", { name: "TEST / USDC" })).toBeNull();
  });
  it("shows provider failure and retry without inventing empty data", async () => {
    mocks.discover.mockRejectedValue(new Error("DEX Screener is unavailable. Retry the search."));
    setup();
    fireEvent.change(screen.getByLabelText("Token contract address or search"), {
      target: { value: "TEST" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find pools" }));
    expect((await screen.findByRole("alert")).textContent).toContain("unavailable");
    expect(screen.queryByText(/No returned pools match/)).toBeNull();
  });
});
