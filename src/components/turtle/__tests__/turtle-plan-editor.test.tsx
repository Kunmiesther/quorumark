import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TurtlePlanEditor } from "../TurtlePlanEditor";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: mocks }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  mocks.from.mockImplementation((table) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "order"]) query[method] = () => query;
    query.then = (resolve: (value: unknown) => void) =>
      resolve({
        error: null,
        data:
          table === "autopilot_workflows"
            ? [
                {
                  id: "live-plan",
                  name: "My live plan",
                  status: "configured",
                  enabled_turtles: ["accumulator"],
                  proposal: { setupBook: "live" },
                  updated_at: "2026-10-03T11:00:00Z",
                  max_daily_entries: 1,
                  max_open_positions: 1,
                },
                {
                  id: "paper-plan",
                  name: "My paper plan",
                  status: "paper",
                  enabled_turtles: ["accumulator"],
                  proposal: { setupBook: "paper" },
                },
              ]
            : [],
      });
    return query;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TurtlePlanEditor
        book="live"
        choices={[
          { key: "accumulator", label: "Accumulator" },
          { key: "vanguard", label: "Vanguard" },
        ]}
      />
    </QueryClientProvider>,
  );
}

describe("editing an existing Turtle mandate", () => {
  it("requires an explicit leverage choice and sends the saved revision with execution settings", async () => {
    mocks.functions.invoke.mockResolvedValue({ data: { ok: true }, error: null });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit plan" }));
    const save = screen.getByRole("button", { name: "Save execution settings" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.functions.invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Leverage ceiling (1–125×)"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Daily entry limit (1–100)"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Concurrent position limit (1–6)"), { target: { value: "4" } });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.functions.invoke).toHaveBeenCalledWith("autopilot-plan", { body: {
      action: "update_execution_settings", workflow_id: "live-plan", expected_updated_at: "2026-10-03T11:00:00Z",
      leverage: 10, max_daily_entries: 40, max_open_positions: 4,
    } }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("keeps books separate and only saves the explicit Turtle selection", async () => {
    mocks.rpc.mockResolvedValue({ error: null });
    mount();
    await screen.findByText("My live plan");
    expect(screen.queryByText("My paper plan")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Vanguard" }));
    expect(mocks.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save Turtle selection" }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith("edit_autopilot_turtles", {
        workflow_id: "live-plan",
        expected_turtles: ["accumulator"],
        selected_turtles: ["accumulator", "vanguard"],
      }),
    );
  });
  it("keeps the editor open and displays a rejected update", async () => {
    mocks.rpc.mockResolvedValue({
      error: { message: "Turtle selection changed in another session" },
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Turtle selection" }));
    expect((await screen.findByRole("alert")).textContent).toContain("another session");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
