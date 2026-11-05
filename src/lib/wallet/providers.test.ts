// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metamaskConnect = vi.hoisted(() => {
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "personal_sign") return "0xsignature";
      return null;
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const client = {
    accounts: ["0xabc0000000000000000000000000000000000001"],
    connect: vi.fn(async () => ({
      accounts: ["0xabc0000000000000000000000000000000000001"],
      chainId: "0x1",
    })),
    disconnect: vi.fn(async () => undefined),
    getProvider: () => provider,
  };
  return { client, provider, createEVMClient: vi.fn(async () => client) };
});

vi.mock("@metamask/connect-evm", () => ({
  createEVMClient: metamaskConnect.createEVMClient,
}));

type Announce = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: any };

function announce(a: Announce) {
  window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: a }));
}

// Auto-announce whenever a component requests providers.
function autoAnnounce(providers: Announce[]) {
  const handler = () => {
    for (const p of providers) announce(p);
  };
  window.addEventListener("eip6963:requestProvider", handler);
  return () => window.removeEventListener("eip6963:requestProvider", handler);
}

function makeEvm(flags: Record<string, boolean> = {}) {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return ["0xabc0000000000000000000000000000000000001"];
      if (method === "eth_chainId") return "0x1";
      return null;
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
    ...flags,
  };
}

async function freshModule() {
  vi.resetModules();
  return await import("./providers");
}

describe("EIP-6963 provider discovery", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    // Ensure a clean window.
    delete (window as any).ethereum;
    delete (window as any).phantom;
    delete (window as any).solana;
  });
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it("selects each EVM wallet by its own rdns when several are present", async () => {
    const metamask = makeEvm({ isMetaMask: true });
    const coinbase = makeEvm({ isCoinbaseWallet: true });
    const bitget = makeEvm({ isBitget: true });
    const trust = makeEvm({ isTrust: true });
    const rainbow = makeEvm({ isRainbow: true });
    stop = autoAnnounce([
      { info: { uuid: "1", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: metamask },
      {
        info: { uuid: "2", name: "Coinbase Wallet", icon: "", rdns: "com.coinbase.wallet" },
        provider: coinbase,
      },
      {
        info: { uuid: "3", name: "Bitget Wallet", icon: "", rdns: "com.bitget.web3" },
        provider: bitget,
      },
      {
        info: { uuid: "4", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" },
        provider: trust,
      },
      { info: { uuid: "5", name: "Rainbow", icon: "", rdns: "me.rainbow" }, provider: rainbow },
    ]);
    const mod = await freshModule();
    const list = mod.listProviders();
    for (const id of ["metamask", "coinbase", "bitget", "trust", "rainbow"] as const) {
      const p = list.find((x) => x.id === id)!;
      expect(p.status).toBe("available");
    }
    // Confirm no cross-labeling: connect goes to the correct underlying provider.
    await mod.connectProvider("metamask");
    expect(metamask.request).toHaveBeenCalled();
    expect(coinbase.request).not.toHaveBeenCalled();
    expect(bitget.request).not.toHaveBeenCalled();
    expect(trust.request).not.toHaveBeenCalled();
    expect(rainbow.request).not.toHaveBeenCalled();
  });

  it("selects Bitget by rdns (bitget or bitkeep variant)", async () => {
    const bitget = makeEvm({ isBitget: true });
    stop = autoAnnounce([
      {
        info: { uuid: "1", name: "Bitget Wallet", icon: "", rdns: "com.bitget.web3" },
        provider: bitget,
      },
    ]);
    const mod = await freshModule();
    const list = mod.listProviders();
    expect(list.find((p) => p.id === "bitget")!.status).toBe("available");
  });

  it("selects Trust Wallet by rdns com.trustwallet.app", async () => {
    const trust = makeEvm({ isTrust: true });
    stop = autoAnnounce([
      {
        info: { uuid: "1", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" },
        provider: trust,
      },
    ]);
    const mod = await freshModule();
    const list = mod.listProviders();
    expect(list.find((p) => p.id === "trust")!.status).toBe("available");
    expect(list.find((p) => p.id === "metamask")!.status).toBe("available");
  });

  it("selects Rainbow by rdns me.rainbow", async () => {
    const rainbow = makeEvm({ isRainbow: true });
    stop = autoAnnounce([
      { info: { uuid: "1", name: "Rainbow", icon: "", rdns: "me.rainbow" }, provider: rainbow },
    ]);
    const mod = await freshModule();
    const list = mod.listProviders();
    expect(list.find((p) => p.id === "rainbow")!.status).toBe("available");
    expect(list.find((p) => p.id === "metamask")!.status).toBe("available");
  });

  it("resolves collisions: Coinbase + Bitget + MetaMask all present", async () => {
    const metamask = makeEvm({ isMetaMask: true });
    const coinbase = makeEvm({ isCoinbaseWallet: true });
    const bitget = makeEvm({ isBitget: true });
    stop = autoAnnounce([
      { info: { uuid: "1", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: metamask },
      {
        info: { uuid: "2", name: "Coinbase Wallet", icon: "", rdns: "com.coinbase.wallet" },
        provider: coinbase,
      },
      {
        info: { uuid: "3", name: "Bitget Wallet", icon: "", rdns: "com.bitget.web3" },
        provider: bitget,
      },
    ]);
    const mod = await freshModule();
    const list = mod.listProviders();
    expect(list.find((p) => p.id === "coinbase")!.status).toBe("available");
    expect(list.find((p) => p.id === "bitget")!.status).toBe("available");
    expect(list.find((p) => p.id === "metamask")!.status).toBe("available");
    // Connect goes to the correct provider (Coinbase's mocked request, not MetaMask's).
    const res = await mod.connectProvider("coinbase");
    expect(coinbase.request).toHaveBeenCalled();
    expect(metamask.request).not.toHaveBeenCalled();
    expect(res.chain).toBe("ethereum");
  });

  it("keeps MetaMask available through its remote connector when no wallet announces", async () => {
    stop = autoAnnounce([]);
    const mod = await freshModule();
    const list = mod.listProviders();
    expect(list.find((p) => p.id === "coinbase")!.status).toBe("not_installed");
    expect(list.find((p) => p.id === "bitget")!.status).toBe("not_installed");
    expect(list.find((p) => p.id === "metamask")!.status).toBe("available");
    expect(list.find((p) => p.id === "trust")!.status).toBe("not_installed");
    expect(list.find((p) => p.id === "rainbow")!.status).toBe("not_installed");
    await expect(mod.connectProvider("coinbase")).rejects.toThrow(/not installed/i);
    await expect(mod.connectProvider("metamask")).resolves.toMatchObject({
      provider: "metamask",
      chain: "ethereum",
      chainId: "0x1",
    });
  });

  it("Phantom detection via window.phantom.solana", async () => {
    (window as any).phantom = {
      solana: {
        isPhantom: true,
        publicKey: { toString: () => "SoLaNa1" },
        connect: vi.fn(async () => ({ publicKey: { toString: () => "SoLaNa1" } })),
        signMessage: vi.fn(),
      },
    };
    const mod = await freshModule();
    expect(mod.listProviders().find((p) => p.id === "phantom")!.status).toBe("available");
  });

  it("WalletConnect: needs_configuration when projectId is absent", async () => {
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "");
    try {
      const mod = await freshModule();
      const wc = mod.listProviders().find((p) => p.id === "walletconnect")!;
      expect(wc.status).toBe("needs_configuration");
      await expect(mod.connectProvider("walletconnect")).rejects.toThrow(
        /projectId|not configured/i,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not expose a custodial Turtle Wallet provider (non-custodial only)", async () => {
    const mod = await freshModule();
    expect(mod.listProviders().some((p) => p.id === ("turtle" as string))).toBe(false);
  });
});

describe("attachWalletListeners", () => {
  it("EVM: accountsChanged → onAccountsChanged, empty array → onDisconnect", async () => {
    const coinbase = makeEvm({ isCoinbaseWallet: true });
    const listeners: Record<string, ((...a: any[]) => void)[]> = {};
    coinbase.on.mockImplementation((event: string, cb: any) => {
      (listeners[event] ||= []).push(cb);
    });
    const stop = autoAnnounce([
      {
        info: { uuid: "1", name: "Coinbase Wallet", icon: "", rdns: "com.coinbase.wallet" },
        provider: coinbase,
      },
    ]);
    const mod = await freshModule();
    // trigger discovery
    mod.listProviders();

    const onAccountsChanged = vi.fn();
    const onDisconnect = vi.fn();
    const onChainChanged = vi.fn();
    const cleanup = mod.attachWalletListeners("coinbase", {
      onAccountsChanged,
      onChainChanged,
      onDisconnect,
    });

    listeners["accountsChanged"][0](["0xnew"]);
    expect(onAccountsChanged).toHaveBeenCalledWith(["0xnew"]);

    listeners["accountsChanged"][0]([]);
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    listeners["chainChanged"][0]("0x2105");
    expect(onChainChanged).toHaveBeenCalledWith("0x2105");

    cleanup();
    stop();
  });
});
