import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SynFuturesRegistration } from "./SynFuturesRegistration";

const api = vi.hoisted(() => ({ read: vi.fn(), register: vi.fn() }));
vi.mock("@/lib/exchanges/synfutures/registration.functions", () => ({
  readSynFuturesRegistration: api.read,
  registerSynFuturesAccount: api.register,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "test" } } }) } },
}));
const record = {
  wallet_id: "wallet",
  setup_revision: 1,
  safe_address: "safe",
  module_address: "module",
  verified_at: "2026-09-29T15:00:00Z",
  status: "deployed_operator_pending",
  execution_ready: false,
};
function show(props = { userId: "owner", walletId: "wallet", revision: 1 }) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SynFuturesRegistration {...props} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  api.read.mockResolvedValue(null);
  api.register.mockResolvedValue(record);
});
afterEach(cleanup);
describe("SynFutures registration control", () => {
  it("reads on mount but never registers automatically", async () => {
    show();
    await screen.findByText("Account not registered · not live");
    expect(api.register).not.toHaveBeenCalled();
  });
  it("registers the saved revision only on click and still reports not live", async () => {
    show();
    await screen.findByText("Account not registered · not live");
    fireEvent.click(screen.getByRole("button", { name: "Register verified account" }));
    await screen.findByText("Account registered · operator approval pending · not live");
    expect(api.register).toHaveBeenCalledExactlyOnceWith({
      data: { walletId: "wallet", expectedRevision: 1 },
      headers: { Authorization: "Bearer test" },
    });
    expect(screen.getByRole("button", { name: "Register verified account" })).toBeDisabled();
  });
  it("allows re-registration after a saved revision changes", async () => {
    api.read.mockResolvedValue(record);
    show({ userId: "owner", walletId: "wallet", revision: 2 });
    await screen.findByText("Saved setup changed · re-register this revision · not live");
    expect(screen.getByRole("button", { name: "Register verified account" })).toBeEnabled();
  });
  it("blocks registration while status is unavailable", async () => {
    api.read.mockRejectedValue(new Error("offline"));
    show();
    await screen.findByText("Registration status unavailable · not live");
    expect(screen.getByRole("button", { name: "Register verified account" })).toBeDisabled();
    expect(api.register).not.toHaveBeenCalled();
  });
  it("keeps a failed mutation retryable without claiming success", async () => {
    api.register.mockRejectedValue(new Error("Setup changed; reload"));
    show();
    await screen.findByText("Account not registered · not live");
    fireEvent.click(screen.getByRole("button", { name: "Register verified account" }));
    await screen.findByRole("alert");
    expect(
      screen.queryByText("Account registered · operator approval pending · not live"),
    ).toBeNull();
    expect(api.register).toHaveBeenCalledTimes(1);
  });
  it("isolates cached registration by owner and wallet", async () => {
    api.read.mockImplementation(async ({ data }: { data: { walletId: string } }) =>
      data.walletId === "wallet" ? record : null,
    );
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <SynFuturesRegistration key="a" userId="owner" walletId="wallet" revision={1} />
      </QueryClientProvider>,
    );
    await screen.findByText("Account registered · operator approval pending · not live");
    view.rerender(
      <QueryClientProvider client={client}>
        <SynFuturesRegistration key="b" userId="other" walletId="other-wallet" revision={1} />
      </QueryClientProvider>,
    );
    await screen.findByText("Account not registered · not live");
    expect(screen.queryByText("Trading account: safe")).toBeNull();
    expect(api.register).not.toHaveBeenCalled();
  });
});
