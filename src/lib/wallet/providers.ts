import { PUBLIC_WALLETCONNECT_PROJECT_ID } from "@/lib/public-env";

// Client-side wallet provider adapters.
//
// Injected EVM providers are discovered via EIP-6963
// (https://eips.ethereum.org/EIPS/eip-6963) so we NEVER assume
// `window.ethereum` is a specific wallet. MetaMask additionally uses its
// official connector when no injected extension is visible, which supports
// desktop QR, mobile deep-link, and MetaMask's in-app browser.
//
// Phantom is detected on `window.phantom?.solana` / `window.solana?.isPhantom`.
//
// We NEVER ask for seed phrases, private keys, or passwords. We only
// request wallet connection + signMessage here. The separate blockchain
// transaction flow uses an explicitly selected provider and owner confirmation.
// Challenge signatures are verified
// server-side by the wallet-verify edge function.

export type WalletChain = "solana" | "ethereum";
export type WalletProviderId =
  "phantom" | "coinbase" | "bitget" | "metamask" | "trust" | "rainbow" | "walletconnect";

type EvmProviderId = "coinbase" | "bitget" | "metamask" | "trust" | "rainbow";

export type WalletProviderMeta = {
  id: WalletProviderId;
  name: string;
  chain: WalletChain;
  installUrl: string;
  status: "available" | "not_installed" | "needs_configuration" | "coming_soon";
  /** Display name of the actual browser provider that will be used (EIP-6963). */
  detectedName?: string;
};

export type WalletConnectResult = {
  publicAddress: string;
  provider: WalletProviderId;
  chain: WalletChain;
  /** Present for EVM providers; hex chain id (e.g. "0x1"). */
  chainId?: string;
};

export type SignResult = {
  signature: string; // base58/base64 (solana) or 0x-hex (evm)
};

export const WALLETCONNECT_PROJECT_ID: string | undefined = PUBLIC_WALLETCONNECT_PROJECT_ID;

// ---- Injected provider typings ------------------------------------------------

type SolanaProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect?: () => Promise<void>;
  signMessage: (msg: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
};

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  isCoinbaseWallet?: boolean;
  isBitKeep?: boolean;
  isBitget?: boolean;
  isMetaMask?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isRainbow?: boolean;
  providers?: Eip1193Provider[];
};

type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
};

declare global {
  interface Window {
    solana?: SolanaProvider;
    phantom?: { solana?: SolanaProvider };
    ethereum?: Eip1193Provider;
  }
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
  }
}

// ---- EIP-6963 discovery -------------------------------------------------------

// rdns -> detail (last announcement wins for that rdns).
const announced = new Map<string, Eip6963ProviderDetail>();
const listeners = new Set<() => void>();
let discoveryStarted = false;

function notify() {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

function ensureDiscovery() {
  if (discoveryStarted || typeof window === "undefined") return;
  discoveryStarted = true;
  window.addEventListener("eip6963:announceProvider", (evt) => {
    const detail = evt.detail;
    if (!detail?.info?.rdns || !detail.provider) return;
    announced.set(detail.info.rdns, detail);
    notify();
  });
  // Ask any already-loaded wallets to re-announce.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** Subscribe to provider-list changes (EIP-6963 late announcements). */
export function subscribeProviders(cb: () => void): () => void {
  ensureDiscovery();
  listeners.add(cb);
  // Re-request on subscribe in case wallets loaded after page load.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  return () => {
    listeners.delete(cb);
  };
}

const RDNS: Record<EvmProviderId, string[]> = {
  coinbase: ["com.coinbase.wallet"],
  bitget: ["com.bitget.web3", "com.bitkeep.wallet"],
  metamask: ["io.metamask", "io.metamask.mobile"],
  trust: ["com.trustwallet.app"],
  rainbow: ["me.rainbow"],
};

function findEip6963(id: EvmProviderId): Eip6963ProviderDetail | null {
  for (const rdns of RDNS[id]) {
    const d = announced.get(rdns);
    if (d) return d;
  }
  return null;
}

/**
 * Legacy fallback: some wallets still don't announce via EIP-6963.
 * We ONLY accept a legacy provider if its flag unambiguously identifies as
 * the requested wallet (never fall back to a generic/unknown window.ethereum).
 * For MetaMask we additionally require the absence of other wallets' flags so
 * a wallet impersonating `isMetaMask` (Coinbase, Trust, etc.) is not misrouted.
 */
function findLegacyEvm(id: EvmProviderId): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = window.ethereum;
  if (!eth) return null;
  const match = (p: Eip1193Provider): boolean => {
    switch (id) {
      case "coinbase":
        return !!p.isCoinbaseWallet;
      case "bitget":
        return !!(p.isBitKeep || p.isBitget);
      case "trust":
        return !!(p.isTrust || p.isTrustWallet);
      case "rainbow":
        return !!p.isRainbow;
      case "metamask":
        return (
          !!p.isMetaMask &&
          !p.isCoinbaseWallet &&
          !p.isBitKeep &&
          !p.isBitget &&
          !p.isTrust &&
          !p.isTrustWallet &&
          !p.isRainbow
        );
    }
  };
  if (eth.providers?.length) {
    const p = eth.providers.find(match);
    if (p) return p;
  }
  return match(eth) ? eth : null;
}

function getEvmProvider(id: EvmProviderId): {
  provider: Eip1193Provider;
  displayName?: string;
} | null {
  const eip = findEip6963(id);
  if (eip) return { provider: eip.provider, displayName: eip.info.name };
  const legacy = findLegacyEvm(id);
  if (legacy) return { provider: legacy };
  return null;
}

function getPhantom(): SolanaProvider | null {
  if (typeof window === "undefined") return null;
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solana?.isPhantom) return window.solana;
  return null;
}

// ---- Public API ---------------------------------------------------------------

/** Resolve only the selected wallet brand. Never substitute another extension. */
export async function getTransactionProvider(id: string): Promise<Eip1193Provider> {
  ensureDiscovery();
  if (id === "walletconnect") {
    const { getWalletConnectProvider } = await import("./walletconnect");
    return getWalletConnectProvider();
  }
  if (id === "metamask" && !getEvmProvider("metamask")) {
    const { getMetaMaskTransactionProvider } = await import("./metamask-connect");
    return getMetaMaskTransactionProvider();
  }
  if (!isEvmId(id as WalletProviderId)) throw new WalletError("PROVIDER_UNAVAILABLE", "Choose a supported EVM wallet provider.");
  const found = getEvmProvider(id as EvmProviderId);
  if (!found) throw new WalletError("PROVIDER_UNAVAILABLE", "Open this page in the browser with your selected wallet connected.");
  return found.provider;
}

export function listProviders(): WalletProviderMeta[] {
  ensureDiscovery();
  const coinbase = getEvmProvider("coinbase");
  const bitget = getEvmProvider("bitget");
  const metamask = getEvmProvider("metamask");
  const trust = getEvmProvider("trust");
  const rainbow = getEvmProvider("rainbow");
  return [
    {
      id: "phantom",
      name: "Phantom",
      chain: "solana",
      installUrl: "https://phantom.app/download",
      status: getPhantom() ? "available" : "not_installed",
    },
    {
      id: "metamask",
      name: "MetaMask",
      chain: "ethereum",
      installUrl: "https://metamask.io/download",
      status: "available",
      detectedName: metamask?.displayName,
    },
    {
      id: "coinbase",
      name: "Coinbase Wallet",
      chain: "ethereum",
      installUrl: "https://www.coinbase.com/wallet/downloads",
      status: coinbase ? "available" : "not_installed",
      detectedName: coinbase?.displayName,
    },
    {
      id: "bitget",
      name: "Bitget Wallet",
      chain: "ethereum",
      installUrl: "https://web3.bitget.com/en/wallet-download",
      status: bitget ? "available" : "not_installed",
      detectedName: bitget?.displayName,
    },
    {
      id: "trust",
      name: "Trust Wallet",
      chain: "ethereum",
      installUrl: "https://trustwallet.com/browser-extension",
      status: trust ? "available" : "not_installed",
      detectedName: trust?.displayName,
    },
    {
      id: "rainbow",
      name: "Rainbow",
      chain: "ethereum",
      installUrl: "https://rainbow.me/extension",
      status: rainbow ? "available" : "not_installed",
      detectedName: rainbow?.displayName,
    },
    {
      id: "walletconnect",
      name: "WalletConnect",
      chain: "ethereum",
      installUrl: "https://walletconnect.network/",
      status: WALLETCONNECT_PROJECT_ID ? "available" : "needs_configuration",
    },
  ];
}

// Uniform, user-facing wallet errors.
export class WalletError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const EVM_IDS = ["coinbase", "bitget", "metamask", "trust", "rainbow"] as const;
function isEvmId(id: WalletProviderId): id is EvmProviderId {
  return (EVM_IDS as readonly string[]).includes(id);
}
const EVM_NAME: Record<EvmProviderId, string> = {
  coinbase: "Coinbase Wallet",
  bitget: "Bitget Wallet",
  metamask: "MetaMask",
  trust: "Trust Wallet",
  rainbow: "Rainbow",
};

export async function connectProvider(id: WalletProviderId): Promise<WalletConnectResult> {
  if (id === "walletconnect") {
    if (!WALLETCONNECT_PROJECT_ID) {
      throw new WalletError(
        "PROVIDER_UNAVAILABLE",
        "WalletConnect needs a projectId (set VITE_WALLETCONNECT_PROJECT_ID).",
      );
    }
    const { connectWalletConnect } = await import("./walletconnect");
    const { address, chainId } = await connectWalletConnect();
    return { publicAddress: address, provider: id, chain: "ethereum", chainId };
  }
  if (id === "phantom") {
    const p = getPhantom();
    if (!p) throw new WalletError("EXTENSION_NOT_INSTALLED", "Phantom is not installed.");
    try {
      const res = await p.connect();
      return { publicAddress: res.publicKey.toString(), provider: id, chain: "solana" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Connection rejected.";
      throw new WalletError("USER_REJECTED_CONNECT", msg);
    }
  }
  if (id === "metamask") {
    const injected = getEvmProvider("metamask");
    if (!injected) {
      try {
        const { connectMetaMask } = await import("./metamask-connect");
        const { address, chainId } = await connectMetaMask();
        return { publicAddress: address, provider: id, chain: "ethereum", chainId };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Connection rejected.";
        throw new WalletError("USER_REJECTED_CONNECT", msg);
      }
    }
  }
  // EVM via EIP-6963 (with legacy fallback).
  if (!isEvmId(id)) {
    throw new WalletError("PROVIDER_UNAVAILABLE", "Provider is not available.");
  }
  const evm = getEvmProvider(id);
  if (!evm) {
    throw new WalletError("EXTENSION_NOT_INSTALLED", `${EVM_NAME[id]} is not installed.`);
  }
  try {
    const accounts = (await evm.provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.length) throw new WalletError("USER_REJECTED_CONNECT", "No account returned.");
    let chainId: string | undefined;
    try {
      chainId = (await evm.provider.request({ method: "eth_chainId" })) as string;
    } catch {
      /* optional */
    }
    return { publicAddress: accounts[0], provider: id, chain: "ethereum", chainId };
  } catch (e) {
    if (e instanceof WalletError) throw e;
    const msg = e instanceof Error ? e.message : "Connection rejected.";
    throw new WalletError("USER_REJECTED_CONNECT", msg);
  }
}

export async function signChallenge(
  id: WalletProviderId,
  address: string,
  challengeText: string,
): Promise<SignResult> {
  if (id === "phantom") {
    const p = getPhantom();
    if (!p) throw new WalletError("PROVIDER_UNAVAILABLE", "Phantom connection lost.");
    if (!p.publicKey || p.publicKey.toString() !== address) {
      throw new WalletError("ADDRESS_CHANGED", "Wallet account changed. Reconnect and try again.");
    }
    try {
      const encoded = new TextEncoder().encode(challengeText);
      const res = await p.signMessage(encoded, "utf8");
      return { signature: toBase64(res.signature) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Signature rejected.";
      throw new WalletError("USER_REJECTED_SIGN", msg);
    }
  }
  if (id === "metamask" && !getEvmProvider("metamask")) {
    try {
      const hex = "0x" + toHex(new TextEncoder().encode(challengeText));
      const { personalSignMetaMask } = await import("./metamask-connect");
      return { signature: await personalSignMetaMask(address, hex) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Signature rejected.";
      if (/account changed/i.test(msg)) {
        throw new WalletError("ADDRESS_CHANGED", msg);
      }
      throw new WalletError("USER_REJECTED_SIGN", msg);
    }
  }
  if (isEvmId(id)) {
    const evm = getEvmProvider(id);
    if (!evm) throw new WalletError("PROVIDER_UNAVAILABLE", "Wallet connection lost.");
    try {
      const currentAccounts = (await evm.provider.request({ method: "eth_accounts" })) as string[];
      if (!currentAccounts?.length || currentAccounts[0].toLowerCase() !== address.toLowerCase()) {
        throw new WalletError(
          "ADDRESS_CHANGED",
          "Wallet account changed. Reconnect and try again.",
        );
      }
      const hex = "0x" + toHex(new TextEncoder().encode(challengeText));
      const sig = (await evm.provider.request({
        method: "personal_sign",
        params: [hex, address],
      })) as string;
      return { signature: sig };
    } catch (e) {
      if (e instanceof WalletError) throw e;
      const msg = e instanceof Error ? e.message : "Signature rejected.";
      throw new WalletError("USER_REJECTED_SIGN", msg);
    }
  }
  if (id === "walletconnect") {
    if (!WALLETCONNECT_PROJECT_ID) {
      throw new WalletError("PROVIDER_UNAVAILABLE", "WalletConnect is not configured.");
    }
    const { personalSignWalletConnect } = await import("./walletconnect");
    const sig = await personalSignWalletConnect(address, challengeText);
    return { signature: sig };
  }
  throw new WalletError("PROVIDER_UNAVAILABLE", "Provider is not available.");
}

// ---- Live account / chain / disconnect events --------------------------------

export type WalletEventHandlers = {
  onAccountsChanged?: (accounts: string[]) => void;
  onChainChanged?: (chainId: string) => void;
  onDisconnect?: () => void;
};

/**
 * Attach live listeners to the underlying provider for a wallet id.
 * Returns a cleanup fn. Safe to call when the provider isn't available
 * (returns a no-op cleanup).
 */
export function attachWalletListeners(
  id: WalletProviderId,
  handlers: WalletEventHandlers,
): () => void {
  if (id === "phantom") {
    const p = getPhantom();
    if (!p?.on || !p.removeListener) return () => {};
    const accountCb = (arg: unknown) => {
      // Phantom emits the new PublicKey (or null on disconnect).
      const pk = arg as { toString?: () => string } | null;
      const addr = pk?.toString?.();
      if (!addr) handlers.onDisconnect?.();
      else handlers.onAccountsChanged?.([addr]);
    };
    const discCb = () => handlers.onDisconnect?.();
    p.on("accountChanged", accountCb);
    p.on("disconnect", discCb);
    return () => {
      p.removeListener?.("accountChanged", accountCb);
      p.removeListener?.("disconnect", discCb);
    };
  }
  if (isEvmId(id)) {
    const evm = getEvmProvider(id);
    if (id === "metamask" && !evm) {
      let cleanup = () => {};
      let disposed = false;
      void import("./metamask-connect").then(({ attachMetaMaskConnectListeners }) => {
        if (!disposed) cleanup = attachMetaMaskConnectListeners(handlers);
      });
      return () => {
        disposed = true;
        cleanup();
      };
    }
    if (!evm?.provider.on || !evm.provider.removeListener) return () => {};
    const accCb = (arg: unknown) => {
      const accounts = (arg as string[]) ?? [];
      if (!accounts.length) handlers.onDisconnect?.();
      else handlers.onAccountsChanged?.(accounts);
    };
    const chainCb = (arg: unknown) => handlers.onChainChanged?.(String(arg));
    const discCb = () => handlers.onDisconnect?.();
    evm.provider.on("accountsChanged", accCb);
    evm.provider.on("chainChanged", chainCb);
    evm.provider.on("disconnect", discCb);
    return () => {
      evm.provider.removeListener?.("accountsChanged", accCb);
      evm.provider.removeListener?.("chainChanged", chainCb);
      evm.provider.removeListener?.("disconnect", discCb);
    };
  }
  if (id === "walletconnect" && WALLETCONNECT_PROJECT_ID) {
    // Attach lazily; if the WC session hasn't initialized we simply skip.
    let cleaned = false;
    let cleanup: (() => void) | null = null;
    void (async () => {
      try {
        const { getWalletConnectProvider } = await import("./walletconnect");
        const p = await getWalletConnectProvider();
        if (cleaned || !p.on || !p.removeListener) return;
        const accCb = (arg: unknown) => {
          const accounts = (arg as string[]) ?? [];
          if (!accounts.length) handlers.onDisconnect?.();
          else handlers.onAccountsChanged?.(accounts);
        };
        const chainCb = (arg: unknown) => handlers.onChainChanged?.(String(arg));
        const discCb = () => handlers.onDisconnect?.();
        const sessCb = () => handlers.onDisconnect?.();
        p.on("accountsChanged", accCb);
        p.on("chainChanged", chainCb);
        p.on("disconnect", discCb);
        p.on("session_delete", sessCb);
        p.on("session_expire", sessCb);
        cleanup = () => {
          p.removeListener?.("accountsChanged", accCb);
          p.removeListener?.("chainChanged", chainCb);
          p.removeListener?.("disconnect", discCb);
          p.removeListener?.("session_delete", sessCb);
          p.removeListener?.("session_expire", sessCb);
        };
      } catch {
        /* WC not initialized — no listeners to attach yet */
      }
    })();
    return () => {
      cleaned = true;
      cleanup?.();
    };
  }
  return () => {};
}

/** Best-effort local provider disconnect (called before server disconnect). */
export async function disconnectProviderLocal(id: WalletProviderId): Promise<void> {
  try {
    if (id === "phantom") {
      await getPhantom()?.disconnect?.();
      return;
    }
    if (id === "walletconnect") {
      if (!WALLETCONNECT_PROJECT_ID) return;
      const { disconnectWalletConnect } = await import("./walletconnect");
      await disconnectWalletConnect();
      return;
    }
    if (isEvmId(id)) {
      const evm = getEvmProvider(id);
      if (id === "metamask" && !evm) {
        const { disconnectMetaMask } = await import("./metamask-connect");
        await disconnectMetaMask();
        return;
      }
      // EIP-1193 has no standard disconnect; attempt wallet_revokePermissions
      // (Coinbase supports it; others silently ignore).
      try {
        await evm?.provider.request({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        });
      } catch {
        /* not supported — that's fine */
      }
    }
  } catch {
    /* swallow */
  }
}
