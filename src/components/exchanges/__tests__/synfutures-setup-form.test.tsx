import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SynFuturesSetupForm } from "../trust/SynFuturesSetupForm";

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/exchanges/synfutures/setup.functions", () => ({
  readSynFuturesSetup: mocks.read,
  saveSynFuturesSetup: mocks.save,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "test-only" } } }) },
  },
}));
const wallet = "00000000-0000-4000-8000-000000000001";
const saved = {
  id: "draft",
  wallet_id: wallet,
  allocation_usdc: 100,
  max_leverage: 33,
  chain_id: 8453,
  status: "draft",
  revision: 1,
  updated_at: "2026-09-27T12:00:00Z",
};
const clients: QueryClient[] = [];
function mount(walletId = wallet) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <SynFuturesSetupForm walletId={walletId} userId="owner" />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(null);
  mocks.save.mockResolvedValue(saved);
});
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
});

describe("SynFutures saved setup", () => {
  it("saves explicit configuration and shows draft, never live", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Total allocation (USDC)"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText("Maximum leverage (×)"), { target: { value: "33" } });
    fireEvent.click(screen.getByRole("button", { name: "Save setup draft" }));
    await screen.findByText("Setup saved · wallet approval pending · not live");
    expect(mocks.save.mock.calls[0][0].data).toEqual({
      walletId: wallet,
      allocationUsdc: "100",
      maxLeverage: 33,
      expectedRevision: 0,
    });
    expect(
      (screen.getByRole("button", { name: "Save setup draft" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("loads existing values, tracks unsaved edits and uses the revision", async () => {
    mocks.read.mockResolvedValue(saved);
    mount();
    const amount = (await screen.findByLabelText("Total allocation (USDC)")) as HTMLInputElement;
    expect(amount.value).toBe("100");
    fireEvent.change(amount, { target: { value: "90" } });
    expect(screen.getByText("Unsaved setup · not live")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save setup draft" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(mocks.save.mock.calls[0][0].data.expectedRevision).toBe(1);
  });
  it("does not render editable defaults after a failed read", async () => {
    mocks.read.mockRejectedValue(new Error("unavailable"));
    mount();
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Total allocation (USDC)")).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("keeps failed saves unsaved and presents a recoverable error", async () => {
    mocks.save.mockRejectedValue(new Error("Setup changed in another session. Reload."));
    mount();
    fireEvent.change(await screen.findByLabelText("Total allocation (USDC)"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText("Maximum leverage (×)"), { target: { value: "33" } });
    fireEvent.click(screen.getByRole("button", { name: "Save setup draft" }));
    await screen.findByText("Setup changed in another session. Reload.");
    expect(screen.queryByText("Setup saved · wallet approval pending · not live")).toBeNull();
  });
});
