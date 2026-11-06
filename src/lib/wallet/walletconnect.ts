// Lazy WalletConnect adapter (Reown EthereumProvider).
//
// SAFETY: this module MUST NOT import @walletconnect/* at the top level.
// If VITE_WALLETCONNECT_PROJECT_ID is missing we never load the code, and
// the production build still works. All @walletconnect/* imports live inside
// getWalletConnectProvider() and are only reached when a projectId exists
// AND the user clicks Connect on WalletConnect.

import { WALLETCONNECT_PROJECT_ID, WalletError } from "./providers";

// Minimal EIP-1193 shape we rely on. Kept local so this file has no static
// dependency on any WalletConnect package.
export type Eip1193Like = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  disconnect?: () => Promise<void>;
};

type Cached = { provider: Eip1193Like; projectId: string };
let cached: Cached | null = null;
let initPromise: Promise<Cached> | null = null;

const DEFAULT_EVM_CHAINS = [1, 8453, 137, 42161, 10, 56]; // eth, base, polygon, arbitrum, optimism, bsc

export function isWalletConnectConfigured(): boolean {
  return !!WALLETCONNECT_PROJECT_ID;
}

async function initProvider(): Promise<Cached> {
  if (!WALLETCONNECT_PROJECT_ID) {
    throw new WalletError(
      "PROVIDER_UNAVAILABLE",
      "WalletConnect needs a projectId (set VITE_WALLETCONNECT_PROJECT_ID).",
    );
  }
  // Dynamic import — Vite code-splits this out. It only downloads if the user
  // actually opens WalletConnect. If the package isn't installed the runtime
  // import throws a caught WalletError, keeping the rest of the app alive.
  let mod: { EthereumProvider: { init: (opts: unknown) => Promise<Eip1193Like> } };
  try {
    // @ts-expect-error — optional peer, installed lazily
    mod = await import("@walletconnect/ethereum-provider");
  } catch (e) {
    throw new WalletError(
      "PROVIDER_UNAVAILABLE",
      "WalletConnect package is not installed in this build.",
    );
  }
  const provider = (await mod.EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: DEFAULT_EVM_CHAINS,
    showQrModal: true,
    metadata: {
      name: "Quorumark Strategy Exchange",
      description: "Wallet authentication for Quorumark",
      url: typeof window !== "undefined" ? window.location.origin : "https://quorumark.example",
      icons: [],
    },
  })) as Eip1193Like;
  cached = { provider, projectId: WALLETCONNECT_PROJECT_ID };
  return cached;
}

/** Returns the initialized EIP-1193 provider, initializing on first use. */
export async function getWalletConnectProvider(): Promise<Eip1193Like> {
  if (cached) return cached.provider;
  if (!initPromise) {
    initPromise = initProvider().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return (await initPromise).provider;
}

/** Opens the AppKit/QR modal and returns the connected account + chainId. */
export async function connectWalletConnect(): Promise<{ address: string; chainId: string }> {
  const provider = await getWalletConnectProvider();
  try {
    // EthereumProvider.connect() opens the modal / restores an existing session.
    const p = provider as Eip1193Like & { connect?: () => Promise<void> };
    if (typeof p.connect === "function") {
      await p.connect();
    }
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    if (!accounts?.length) {
      throw new WalletError("USER_REJECTED_CONNECT", "No account returned from WalletConnect.");
    }
    const chainId = (await provider.request({ method: "eth_chainId" })) as string;
    return { address: accounts[0], chainId };
  } catch (e) {
    if (e instanceof WalletError) throw e;
    const msg = e instanceof Error ? e.message : "WalletConnect session was not established.";
    // Common: user closed the QR modal, session request expired, etc.
    if (/expired|closed|reject/i.test(msg)) {
      throw new WalletError("WALLETCONNECT_SESSION_EXPIRED", msg);
    }
    throw new WalletError("USER_REJECTED_CONNECT", msg);
  }
}

export async function personalSignWalletConnect(
  address: string,
  challengeText: string,
): Promise<string> {
  const provider = await getWalletConnectProvider();
  const hex =
    "0x" +
    Array.from(new TextEncoder().encode(challengeText))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  try {
    return (await provider.request({
      method: "personal_sign",
      params: [hex, address],
    })) as string;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Signature rejected.";
    throw new WalletError("USER_REJECTED_SIGN", msg);
  }
}

export async function disconnectWalletConnect(): Promise<void> {
  if (!cached) return;
  try {
    await cached.provider.disconnect?.();
  } catch {
    /* swallow — session may already be gone */
  }
  cached = null;
  initPromise = null;
}
