import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockchainSwapExecution } from "../trust/BlockchainSwapExecution";
import { TEST_HASH, testRecord, testRequest } from "@/lib/blockchain/transactions.fixtures";
import * as functions from "@/lib/blockchain/transactions.functions";
import * as wallet from "@/lib/blockchain/walletTransaction";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "test-only" } } }) },
  },
}));
vi.mock("@/lib/blockchain/transactions.functions", () => ({
  prepareBlockchainSwap: vi.fn(),
  claimBlockchainSwap: vi.fn(),
  trackBlockchainSwap: vi.fn(),
  listBlockchainSwaps: vi.fn(),
  declineBlockchainSwap: vi.fn(),
}));
vi.mock("@/lib/wallet/providers", () => ({ getTransactionProvider: async () => ({}) }));
vi.mock("@/lib/blockchain/walletTransaction", async (original) => ({
  ...(await original<typeof wallet>()),
  checkSigningWallet: vi.fn(),
  submitReviewedTransaction: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  const cache = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
  });
  vi.mocked(functions.prepareBlockchainSwap).mockResolvedValue(testRecord());
  vi.mocked(functions.claimBlockchainSwap).mockResolvedValue(testRecord().plan);
  vi.mocked(functions.listBlockchainSwaps).mockResolvedValue([]);
  vi.mocked(functions.trackBlockchainSwap).mockResolvedValue(
    testRecord({ status: "submitted", tx_hash: TEST_HASH }),
  );
  vi.mocked(wallet.submitReviewedTransaction).mockResolvedValue(TEST_HASH);
});
const view = (request = testRequest) => (
  <BlockchainSwapExecution request={request} provider="metamask" valid />
);
async function prepare() {
  fireEvent.click(screen.getByRole("button", { name: "Prepare wallet review" }));
  return screen.findByRole("button", { name: "Confirm in metamask wallet" });
}
describe("wallet review UI", () => {
  it("reports an empty journal instead of appearing unresponsive", async () => {
    render(view());
    fireEvent.click(screen.getByRole("button", { name: "Transaction journal" }));
    expect((await screen.findByRole("status")).textContent).toContain(
      "No wallet transactions recorded on Base yet.",
    );
  });
  it("disables a saved signing review after token selection changes", async () => {
    const { rerender } = render(view());
    await prepare();
    fireEvent.click(screen.getByRole("checkbox"));
    rerender(
      view({
        ...testRequest,
        token: {
          chainId: 8453,
          address: "0x4444444444444444444444444444444444444444",
          decimals: 18,
          symbol: "NEW",
        },
      }),
    );
    expect(
      (screen.getByRole("button", { name: "Confirm in metamask wallet" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(wallet.submitReviewedTransaction).not.toHaveBeenCalled();
  });
  it("invalidates a pending wallet handoff if its form changes", async () => {
    let resolveClaim!: (plan: ReturnType<typeof testRecord>["plan"]) => void;
    vi.mocked(functions.claimBlockchainSwap).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClaim = resolve;
        }),
    );
    vi.mocked(wallet.submitReviewedTransaction).mockImplementationOnce(
      async (_provider, _plan, stillCurrent) => {
        if (!stillCurrent?.()) throw new wallet.WalletSubmissionError("Review changed", true);
        return TEST_HASH;
      },
    );
    const { rerender } = render(view());
    const confirm = await prepare();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);
    await waitFor(() => expect(functions.claimBlockchainSwap).toHaveBeenCalledTimes(1));
    rerender(view({ ...testRequest, amount: "0.02" }));
    resolveClaim(testRecord().plan);
    await screen.findByText("Review changed");
    expect(functions.declineBlockchainSwap).toHaveBeenCalledTimes(1);
    expect(functions.trackBlockchainSwap).not.toHaveBeenCalled();
  });
  it("never invokes review or wallet submission merely by rendering", () => {
    render(view());
    expect(functions.prepareBlockchainSwap).not.toHaveBeenCalled();
    expect(wallet.submitReviewedTransaction).not.toHaveBeenCalled();
  });
  it("requires explicit review and acknowledgement before exactly one wallet handoff", async () => {
    render(view());
    const confirm = (await prepare()) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(functions.trackBlockchainSwap).toHaveBeenCalledTimes(1));
    expect(wallet.submitReviewedTransaction).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Status: submitted/)).toBeTruthy();
  });
  it("disables signing an old review after the form changes but preserves its details", async () => {
    const { rerender } = render(view());
    await prepare();
    fireEvent.click(screen.getByRole("checkbox"));
    rerender(view({ ...testRequest, amount: "0.02" }));
    expect(
      (screen.getByRole("button", { name: "Confirm in metamask wallet" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/form differs/)).toBeTruthy();
    expect(wallet.submitReviewedTransaction).not.toHaveBeenCalled();
  });
  it("recovers an older journal entry even when its amount differs from the form", async () => {
    vi.mocked(functions.listBlockchainSwaps).mockResolvedValue([testRecord({ status: "signing" })]);
    render(view({ ...testRequest, amount: "0.02" }));
    fireEvent.click(screen.getByRole("button", { name: "Transaction journal" }));
    fireEvent.click(await screen.findByRole("button", { name: /Swap · 0.01 · signing/ }));
    fireEvent.change(screen.getByLabelText("Transaction hash"), { target: { value: TEST_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Recover receipt" }));
    await waitFor(() => expect(functions.trackBlockchainSwap).toHaveBeenCalledTimes(1));
    expect(wallet.submitReviewedTransaction).not.toHaveBeenCalled();
  });
  it("leaves unknown wallet submission recoverable instead of offering another send", async () => {
    vi.mocked(wallet.submitReviewedTransaction).mockRejectedValue(
      new wallet.WalletSubmissionError("Submission unknown", false),
    );
    render(view());
    const confirm = await prepare();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);
    await screen.findByText("Submission unknown");
    expect(screen.getByLabelText("Transaction hash")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm in metamask wallet" })).toBeNull();
    expect(functions.declineBlockchainSwap).not.toHaveBeenCalled();
  });
});
