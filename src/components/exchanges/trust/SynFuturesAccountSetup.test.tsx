import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SynFuturesAccountSetup } from "./SynFuturesAccountSetup";

const mocks = vi.hoisted(() => ({ read: vi.fn(), session: vi.fn(), connection: vi.fn(), connect: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: mocks.session } },
}));
vi.mock("@/lib/exchanges/synfutures/registration.functions", () => ({
  readSynFuturesRegistration: mocks.read,
}));
vi.mock("@/lib/exchanges/synfutures/connection.functions", () => ({
  readSynFuturesConnection: mocks.connection, connectSynFuturesAccount: mocks.connect,
}));
vi.mock("./SynFuturesSetupForm", () => ({
  SynFuturesSetupForm: () => <div>New allocation setup</div>,
}));
vi.mock("./SynFuturesDeployment", () => ({
  SynFuturesDeployment: () => <button>Review new deployment</button>,
}));
vi.mock("./SynFuturesRecovery", () => ({ SynFuturesRecovery: () => <div>Native position monitor</div> }));
vi.mock("./SynFuturesActivation", () => ({ SynFuturesActivation: () => <div>Owner trading activation</div> }));
const owner = "0x1111111111111111111111111111111111111111";
const registration = {
  wallet_id: "wallet", owner_address: owner, chain_id: 8453,
  safe_address: "existing-safe", module_address: "existing-module",
  setup_revision: 1, status: "deployed_operator_pending",
  verified_at: "2026-09-29T16:31:01Z",
};
function mount() {
  if (!mocks.connection.getMockImplementation()) mocks.connection.mockResolvedValue(null);
  mocks.session.mockResolvedValue({ data: { session: { access_token: "test-token" } } });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 },
  } })}>
    <SynFuturesAccountSetup userId="user" walletId="wallet" provider="metamask" owner={owner} />
  </QueryClientProvider>);
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("SynFutures existing account routing", () => {
  it("shows a registered account instead of repeating deployment or allocation setup", async () => {
    mocks.read.mockResolvedValue(registration);
    mount();
    expect(await screen.findByText("Existing SynFutures account")).toBeTruthy();
    expect(screen.getByText("Trading account: existing-safe")).toBeTruthy();
    expect(screen.getByText("Module: existing-module")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review new deployment" })).toBeNull();
    expect(screen.queryByText("New allocation setup")).toBeNull();
    expect(mocks.read).toHaveBeenCalledWith({
      data: { walletId: "wallet" }, headers: { Authorization: "Bearer test-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh account registration" }));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  });

  it("connects the registered wallet and shows a saved connected status", async () => {
    mocks.read.mockResolvedValue(registration);
    mocks.connect.mockResolvedValue({ id: "connection", status: "verified", permission_read: true,
      permission_trade: false, is_live: false });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect SynFutures" }));
    expect(await screen.findByText("SynFutures connected · account reads enabled · trading off")).toBeTruthy();
    expect(mocks.connect).toHaveBeenCalledWith({
      data: { walletId: "wallet" }, headers: { Authorization: "Bearer test-token" },
    });
  });

  it("recognizes the saved connection on a fresh mount", async () => {
    mocks.read.mockResolvedValue(registration);
    mocks.connection.mockResolvedValue({ status: "verified", permission_read: true });
    mount();
    expect(await screen.findByText("SynFutures connected · account reads enabled · trading off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review new deployment" })).toBeNull();
  });

  it("shows connection failures without claiming success", async () => {
    mocks.read.mockResolvedValue(registration);
    mocks.connect.mockRejectedValue(new Error("Base account verification unavailable"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect SynFutures" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("SynFutures connected · account reads enabled · trading off")).toBeNull();
  });

  it("withholds deployment while existing account status is loading", () => {
    mocks.read.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByRole("status").textContent).toContain("Checking your existing");
    expect(screen.queryByRole("button", { name: "Review new deployment" })).toBeNull();
  });

  it("does not interpret a failed lookup as a new account and supports retry", async () => {
    mocks.read.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(registration);
    mount();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review new deployment" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry account lookup" }));
    expect(await screen.findByText("Existing SynFutures account")).toBeTruthy();
  });

  it("offers deployment only after the lookup confirms no registration", async () => {
    mocks.read.mockResolvedValue(null);
    mount();
    expect(await screen.findByRole("button", { name: "Review new deployment" })).toBeTruthy();
    expect(screen.getByText("New allocation setup")).toBeTruthy();
  });

  it.each([
    { wallet_id: "different-wallet" },
    { owner_address: "0x2222222222222222222222222222222222222222" },
    { chain_id: 1 },
  ])("rejects mismatched registration identity: %j", async (changed) => {
    mocks.read.mockResolvedValue({ ...registration, ...changed });
    mount();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Existing SynFutures account")).toBeNull();
    expect(screen.queryByRole("button", { name: "Review new deployment" })).toBeNull();
  });
});
