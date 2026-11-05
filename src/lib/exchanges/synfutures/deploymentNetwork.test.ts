// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import artifact from "./module-artifact.json";
import { deploymentIdentity, deploymentPlan } from "./deployment";
import { submitSynDeployment } from "./deploymentWallet";

const owner = `0x${"1".repeat(40)}`;
const identity = deploymentIdentity(
  owner,
  "00000000-0000-4000-8000-000000000001",
  "0x60016000",
  artifact.creationBytecode as Hex,
);
const error = (code: number) => Object.assign(new Error("Wallet request failed"), { code });
beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());
function fixture(stage: "deploy_safe" | "deploy_module" = "deploy_safe") {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const state = {
    chain: "0x1",
    accounts: [owner],
    baseKnown: true,
    addSelectsBase: false,
    switchError: null as Error | null,
    addError: null as Error | null,
    afterSwitch: () => {},
    afterAdd: () => {},
    afterSimulation: () => {},
  };
  const emit = (event: string, value?: unknown) => listeners.get(event)?.(value);
  const setBase = () => {
    state.chain = "0x2105";
    emit("chainChanged", state.chain);
  };
  const provider = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners.set(event, cb);
    }),
    removeListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (listeners.get(event) === cb) listeners.delete(event);
    }),
    request: vi.fn(async ({ method }: { method: string; params?: unknown[] }): Promise<unknown> => {
      if (method === "eth_accounts") return state.accounts;
      if (method === "eth_chainId") return state.chain;
      if (method === "wallet_switchEthereumChain") {
        if (state.switchError) throw state.switchError;
        if (!state.baseKnown) throw error(4902);
        setBase();
        state.afterSwitch();
        return null;
      }
      if (method === "wallet_addEthereumChain") {
        if (state.addError) throw state.addError;
        state.baseKnown = true;
        if (state.addSelectsBase) setBase();
        state.afterAdd();
        return null;
      }
      if (method === "eth_call") {
        state.afterSimulation();
        return stage === "deploy_module" ? `0x${"0".repeat(63)}1` : "0x";
      }
      if (method === "eth_estimateGas") return "0x100000";
      if (method === "eth_sendTransaction") return `0x${"a".repeat(64)}`;
      throw new Error(`Unexpected request ${method}`);
    }),
  };
  const persist = vi.fn();
  const plan = deploymentPlan(identity, stage);
  const methods = () => provider.request.mock.calls.map(([r]) => r.method);
  return { provider, state, emit, persist, plan, methods, listeners };
}
describe("SynFutures selected-wallet Base switch", () => {
  it.each(["deploy_safe", "deploy_module"] as const)(
    "allows unchanged owner and delayed Base notifications during %s simulation",
    async (stage) => {
      const f = fixture(stage);
      f.state.chain = "0x2105";
      f.state.afterSimulation = () => {
        f.emit("accountsChanged", [owner.toUpperCase()]);
        f.emit("chainChanged", "0x2105");
      };
      await submitSynDeployment(f.provider, f.plan, owner, f.persist);
      expect(f.methods().filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
      expect(f.persist).toHaveBeenCalledOnce();
      expect(f.listeners.size).toBe(0);
    },
  );
  it("allows the same owner notification during the requested switch", async () => {
    const f = fixture("deploy_module");
    f.state.afterSwitch = () => f.emit("accountsChanged", [owner]);
    await submitSynDeployment(f.provider, f.plan, owner, f.persist);
    expect(f.methods().filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });
  it.each(["account", "network", "disconnect", "malformedAccount", "malformedChain"])(
    "keeps a real %s invalidation even if correct state returns",
    async (kind) => {
      const f = fixture("deploy_module");
      f.state.chain = "0x2105";
      f.state.afterSimulation = () => {
        if (kind === "account") f.emit("accountsChanged", [`0x${"2".repeat(40)}`]);
        if (kind === "network") f.emit("chainChanged", "0x1");
        if (kind === "disconnect") f.emit("disconnect");
        if (kind === "malformedAccount") f.emit("accountsChanged", null);
        if (kind === "malformedChain") f.emit("chainChanged", "unknown");
        f.emit("accountsChanged", [owner]);
        f.emit("chainChanged", "0x2105");
      };
      await expect(submitSynDeployment(f.provider, f.plan, owner, f.persist)).rejects.toMatchObject(
        { definitelyNotSent: true },
      );
      expect(f.methods()).not.toContain("eth_sendTransaction");
      expect(f.persist).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith("[synfutures/deployment]", {
        event: "review_invalidated",
        reason:
          kind === "disconnect"
            ? "disconnected"
            : ["account", "malformedAccount"].includes(kind)
              ? "account_changed"
              : "network_changed",
        stage: "deploy_module",
        chainId: 8453,
      });
      expect(f.listeners.size).toBe(0);
    },
  );
  it("requests Base, handles its chainChanged event, rechecks identity, then sends once", async () => {
    const f = fixture();
    await submitSynDeployment(f.provider, f.plan, owner, f.persist);
    expect(f.provider.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }],
    });
    expect(f.methods()).toEqual([
      "eth_accounts",
      "eth_chainId",
      "wallet_switchEthereumChain",
      "eth_accounts",
      "eth_chainId",
      "eth_call",
      "eth_estimateGas",
      "eth_accounts",
      "eth_chainId",
      "eth_sendTransaction",
    ]);
    expect(f.persist).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });
  it("does not request a switch when the wallet is already on Base", async () => {
    const f = fixture();
    f.state.chain = "0x2105";
    await submitSynDeployment(f.provider, f.plan, owner, f.persist);
    expect(f.methods()).not.toContain("wallet_switchEthereumChain");
    expect(f.methods()).not.toContain("wallet_addEthereumChain");
  });
  it.each([false, true])(
    "adds only official Base metadata if missing; add selects network=%s",
    async (addSelectsBase) => {
      const f = fixture();
      f.state.baseKnown = false;
      f.state.addSelectsBase = addSelectsBase;
      await submitSynDeployment(f.provider, f.plan, owner, f.persist);
      expect(f.provider.request).toHaveBeenCalledWith({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x2105",
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          },
        ],
      });
      expect(f.methods().filter((m) => m === "wallet_switchEthereumChain")).toHaveLength(
        addSelectsBase ? 1 : 2,
      );
      expect(f.methods().filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
    },
  );
  it.each([4001, -32002, 4200])("does not add or submit after switch error %s", async (code) => {
    const f = fixture();
    f.state.switchError = error(code);
    await expect(submitSynDeployment(f.provider, f.plan, owner, f.persist)).rejects.toMatchObject({
      definitelyNotSent: true,
    });
    expect(f.methods()).not.toContain("wallet_addEthereumChain");
    expect(f.methods()).not.toContain("eth_sendTransaction");
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
  });
  it("does not submit when adding Base is rejected", async () => {
    const f = fixture();
    f.state.baseKnown = false;
    f.state.addError = error(4001);
    await expect(submitSynDeployment(f.provider, f.plan, owner, f.persist)).rejects.toMatchObject({
      definitelyNotSent: true,
    });
    expect(f.methods()).not.toContain("eth_sendTransaction");
    expect(f.persist).not.toHaveBeenCalled();
  });
  it.each([
    "ownerBefore",
    "ownerDuring",
    "silentOwner",
    "wrongChain",
    "disconnect",
    "stale",
    "unmounted",
    "duringSimulation",
    "invalidChain",
  ])("does not submit after %s", async (kind) => {
    const f = fixture();
    let current = true;
    const other = `0x${"2".repeat(40)}`;
    if (kind === "ownerBefore") f.state.accounts = [other];
    if (kind === "ownerDuring")
      f.state.afterSwitch = () => {
        f.emit("accountsChanged", [other]);
      };
    if (kind === "silentOwner")
      f.state.afterSwitch = () => {
        f.state.accounts = [other];
      };
    if (kind === "wrongChain")
      f.state.afterSwitch = () => {
        f.state.chain = "0x1";
      };
    if (kind === "disconnect")
      f.state.afterSwitch = () => {
        f.emit("disconnect");
      };
    if (kind === "stale")
      f.state.afterSwitch = () => {
        f.plan.expiresAt = 0;
      };
    if (kind === "unmounted")
      f.state.afterSwitch = () => {
        current = false;
      };
    if (kind === "duringSimulation")
      f.state.afterSimulation = () => {
        f.state.chain = "0x1";
        f.emit("chainChanged", "0x1");
      };
    if (kind === "invalidChain") f.state.chain = "unknown";
    await expect(
      submitSynDeployment(f.provider, f.plan, owner, f.persist, () => current),
    ).rejects.toMatchObject({ definitelyNotSent: true });
    expect(f.methods()).not.toContain("eth_sendTransaction");
    expect(f.persist).not.toHaveBeenCalled();
    if (["ownerBefore", "invalidChain"].includes(kind))
      expect(f.methods()).not.toContain("wallet_switchEthereumChain");
    expect(f.listeners.size).toBe(0);
  });
  it("does not request the second switch if the wallet changes during network addition", async () => {
    const f = fixture();
    f.state.baseKnown = false;
    f.state.afterAdd = () => {
      f.emit("accountsChanged", []);
    };
    await expect(submitSynDeployment(f.provider, f.plan, owner, f.persist)).rejects.toMatchObject({
      definitelyNotSent: true,
    });
    expect(f.methods().filter((m) => m === "wallet_switchEthereumChain")).toHaveLength(1);
    expect(f.methods()).not.toContain("eth_sendTransaction");
  });
});
