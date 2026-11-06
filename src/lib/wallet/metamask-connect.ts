// MetaMask's official cross-platform connector. Keep it in a separate module so
// the QR/deep-link transport is downloaded only after the user chooses MetaMask.

type MetaMaskEventHandlers = {
  onAccountsChanged?: (accounts: string[]) => void;
  onChainChanged?: (chainId: string) => void;
  onDisconnect?: () => void;
};

type MetaMaskClient = Awaited<
  ReturnType<(typeof import("@metamask/connect-evm"))["createEVMClient"]>
>;

let clientPromise: Promise<MetaMaskClient> | null = null;

async function getClient(): Promise<MetaMaskClient> {
  if (!clientPromise) {
    clientPromise = import("@metamask/connect-evm")
      .then(({ createEVMClient }) =>
        createEVMClient({
          dapp: {
            name: "Quorumark Strategy Exchange",
            url:
              typeof window === "undefined" ? "https://quorumark.example" : window.location.origin,
            iconUrl: typeof window === "undefined" ? undefined : `${window.location.origin}/favicon.svg`,
          },
          api: {
            supportedNetworks: {
              "0x1": "https://ethereum-rpc.publicnode.com",
              "0x2105": "https://mainnet.base.org",
            },
          },
          analytics: { enabled: false },
          // Universal links are more reliable than the `metamask://` custom
          // scheme inside embedded/in-app browsers. They still open the
          // installed MetaMask app, but degrade to MetaMask's web handoff
          // instead of leaving the dapp waiting with no visible prompt.
          mobile: { useDeeplink: false },
          ui: { preferExtension: true, showInstallModal: true },
          skipAutoAnnounce: true,
        }),
      )
      .catch((error) => {
        clientPromise = null;
        throw error;
      });
  }
  return clientPromise;
}

export async function connectMetaMask(): Promise<{ address: string; chainId: string }> {
  const client = await getClient();
  // Activation is always initiated by an explicit user click. Force a fresh
  // permission request so an expired remote session cannot look connected and
  // then silently hang when the onboarding message is sent for signature.
  const { accounts, chainId } = await client.connect({
    chainIds: ["0x1"],
    forceRequest: true,
  });
  const address = accounts[0];
  if (!address) throw new Error("MetaMask did not return an account.");
  return { address, chainId };
}

export async function personalSignMetaMask(address: string, messageHex: string): Promise<string> {
  const client = await getClient();
  const accounts = client.accounts;
  if (!accounts.some((account) => account.toLowerCase() === address.toLowerCase())) {
    throw new Error("Wallet account changed. Reconnect and try again.");
  }
  return (await client.getProvider().request({
    method: "personal_sign",
    params: [messageHex, address],
  })) as string;
}

export function attachMetaMaskConnectListeners(handlers: MetaMaskEventHandlers): () => void {
  let disposed = false;
  let cleanup = () => {};

  void getClient()
    .then((client) => {
      if (disposed) return;
      const provider = client.getProvider();
      const accountsChanged = (accounts: string[]) => handlers.onAccountsChanged?.(accounts);
      const chainChanged = (chainId: string) => handlers.onChainChanged?.(chainId);
      const disconnect = () => handlers.onDisconnect?.();
      provider.on("accountsChanged", accountsChanged);
      provider.on("chainChanged", chainChanged);
      provider.on("disconnect", disconnect);
      cleanup = () => {
        provider.removeListener("accountsChanged", accountsChanged);
        provider.removeListener("chainChanged", chainChanged);
        provider.removeListener("disconnect", disconnect);
      };
    })
    .catch(() => {
      // Connection errors are surfaced by the explicit connect action.
    });

  return () => {
    disposed = true;
    cleanup();
  };
}

export async function disconnectMetaMask(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  await client.disconnect();
  clientPromise = null;
}

/** Does not connect, request permissions or sign. The trade UI checks account and chain. */
export async function getMetaMaskTransactionProvider(): Promise<
  import("./providers").Eip1193Provider
> {
  if (!clientPromise) throw new Error("Connect MetaMask first in your wallet browser.");
  const client = await clientPromise;
  const provider = client.getProvider();
  return {
    request: (args) => provider.request(args),
    on: (event, listener) => {
      if (event === "accountsChanged" || event === "chainChanged" || event === "disconnect")
        provider.on(event, listener);
    },
    removeListener: (event, listener) => {
      if (event === "accountsChanged" || event === "chainChanged" || event === "disconnect")
        provider.removeListener(event, listener);
    },
  };
}
