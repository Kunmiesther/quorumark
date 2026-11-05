import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RefreshPositionsButton } from "../RefreshPositionsButton";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("lucide-react", () => ({ RefreshCw: () => <span /> }));

function mount(book: "paper" | "live" = "live") {
  const queries = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queries, "invalidateQueries");
  render(<QueryClientProvider client={queries}><RefreshPositionsButton book={book} /></QueryClientProvider>);
  return invalidate;
}
beforeEach(() => { cleanup(); invoke.mockReset(); });

describe("Refresh positions", () => {
  it("reads the venue before invalidating owner-scoped rows", async () => {
    invoke.mockResolvedValue({ data: { ok: true, results: [{ ok: true }] }, error: null });
    const invalidate = mount();
    fireEvent.click(screen.getByRole("button", { name: "Refresh open positions" }));
    await screen.findByText("Positions refreshed.");
    expect(invoke).toHaveBeenCalledWith("reconcile-live-positions", { body: {} });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["home-positions", "owner"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["open-positions", "live", "owner"] });
  });
  it("retains a warning after a partial exchange read", async () => {
    invoke.mockResolvedValue({ data: { ok: true, results: [{ ok: true }, { ok: false }] }, error: null });
    const invalidate = mount();
    fireEvent.click(screen.getByRole("button", { name: "Refresh open positions" }));
    await screen.findByText(/Some exchange positions could not be refreshed/);
    expect(screen.queryByText("Positions refreshed.")).toBeNull();
    expect(invalidate).toHaveBeenCalled();
  });
  it("distinguishes fresh positions from unresolved orders", async () => {
    invoke.mockResolvedValue({ data: { ok: true, results: [
      { ok: false, position_snapshot_ok: true, reason: "ORDER_RECONCILIATION_REQUIRED" },
    ] }, error: null });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refresh open positions" }));
    await screen.findByText("Positions refreshed. ApeX order reconciliation is still required.");
  });
  it("disables repeated clicks until the exchange read finishes", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mount();
    const button = screen.getByRole("button", { name: "Refresh open positions" }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    finish({ data: { ok: true, results: [] }, error: null });
    await screen.findByText("Positions refreshed.");
  });
  it("refreshes paper rows without calling a live venue", async () => {
    const invalidate = mount("paper");
    fireEvent.click(screen.getByRole("button", { name: "Refresh open positions" }));
    await screen.findByText("Positions refreshed.");
    expect(invoke).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["open-positions", "paper", "owner"] });
  });
});
