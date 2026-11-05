import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SynFuturesDeployment } from "./SynFuturesDeployment";

const api = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("@/lib/exchanges/synfutures/deployment.functions", () => ({
  inspectSynFuturesDeployment: api.inspect,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "test-session" } } }) },
  },
}));

const props = {
  userId: "user",
  walletId: "wallet",
  provider: "metamask",
  owner: `0x${"1".repeat(40)}`,
};
const plan = {
  stage: "deploy_safe",
  owner: props.owner,
  safe: `0x${"2".repeat(40)}`,
  module: `0x${"3".repeat(40)}`,
  chainId: 8453,
  expiresAt: Date.now() + 120000,
  executionReady: false,
  transaction: { value: "0x0" },
};
const key = "turtlebot:syn-deploy:v1:user:wallet";
function show() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <SynFuturesDeployment {...props} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.stubGlobal("navigator", {
    locks: { request: vi.fn(async (_key, _options, callback) => callback({ name: key })) },
  });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  api.inspect.mockReset();
  api.inspect.mockResolvedValue(plan);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SynFutures deployment controls", () => {
  it("does not inspect or sign automatically", () => {
    show();
    expect(api.inspect).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/do not approve USDC/)).toBeTruthy();
  });
  it("requires an explicit review after an owned-wallet check", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check wallet deployment" }));
    const button = await screen.findByRole("button", {
      name: "Review account deployment in wallet",
    });
    expect(api.inspect).toHaveBeenCalledWith({
      data: { walletId: "wallet" },
      headers: { Authorization: "Bearer test-session" },
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  it("restores pending state and cannot submit again after reload", async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ stage: "deploy_safe", hash: `0x${"a".repeat(64)}` }),
    );
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check wallet deployment" }));
    await screen.findByText(/Step 1 of 2/);
    expect(
      screen.queryByRole("button", { name: "Review account deployment in wallet" }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "View transaction" }).getAttribute("href")).toBe(
      `https://basescan.org/tx/0x${"a".repeat(64)}`,
    );
  });
  it("clears a pending deployment only after chain evidence advances the stage", async () => {
    localStorage.setItem(key, JSON.stringify({ stage: "deploy_safe" }));
    api.inspect.mockResolvedValue({ ...plan, stage: "deploy_module" });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check wallet deployment" }));
    await screen.findByRole("button", { name: "Review module deployment in wallet" });
    expect(localStorage.getItem(key)).toBeNull();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });
  it("does not present deployed contracts as live trading", async () => {
    api.inspect.mockResolvedValue({ ...plan, stage: "deployed", transaction: null });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check wallet deployment" }));
    await screen.findByText("Both contracts verified · trading not activated");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("leaves pending submission intact when the RPC check fails", async () => {
    localStorage.setItem(key, JSON.stringify({ stage: "deploy_safe" }));
    api.inspect.mockRejectedValue(new Error("Base unavailable"));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check wallet deployment" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Base unavailable"));
    expect(localStorage.getItem(key)).not.toBeNull();
  });
  it("recovers a finalized matching revert without approving another transaction", async () => {
    const pending = { stage: "deploy_safe", hash: `0x${"a".repeat(64)}` };
    localStorage.setItem(key, JSON.stringify(pending));
    api.inspect.mockResolvedValue({
      ...plan,
      pendingObservation: { ...pending, status: "reverted" },
    });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check wallet deployment" }));
    await screen.findByText(/previous deployment reverted/);
    expect(api.inspect).toHaveBeenCalledWith({
      data: { walletId: "wallet", pending },
      headers: { Authorization: "Bearer test-session" },
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Review account deployment in wallet",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it.each(["unknown", "included"])("does not unlock a %s receipt", async (status) => {
    const pending = { stage: "deploy_safe", hash: `0x${"a".repeat(64)}` };
    localStorage.setItem(key, JSON.stringify(pending));
    api.inspect.mockResolvedValue({ ...plan, pendingObservation: { ...pending, status } });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check wallet deployment" }));
    await screen.findByText(/Step 1 of 2/);
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("does not erase another tab's submission when an old check returns", async () => {
    const pending = { stage: "deploy_safe", hash: `0x${"a".repeat(64)}` };
    const newer = JSON.stringify({ ...pending, hash: `0x${"b".repeat(64)}` });
    localStorage.setItem(key, JSON.stringify(pending));
    api.inspect.mockImplementation(async () => {
      localStorage.setItem(key, newer);
      return { ...plan, pendingObservation: { ...pending, status: "reverted" } };
    });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check wallet deployment" }));
    await screen.findByText(/Step 1 of 2/);
    expect(localStorage.getItem(key)).toBe(newer);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
