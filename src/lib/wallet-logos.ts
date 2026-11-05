// Wallet provider logo registry. Only official/allowlisted assets.
import phantomLogo from "@/assets/wallets/official/phantom.svg";
import metamaskLogo from "@/assets/wallets/official/metamask.svg";
import coinbaseLogo from "@/assets/wallets/official/coinbase.svg";

export const WALLET_LOGOS: Record<string, string> = {
  phantom: phantomLogo,
  // Bundle the official mark with the application. The former Lovable asset
  // proxy URL can expire independently of a TurtleBot deployment and rendered
  // as a broken-image placeholder on connected-wallet cards.
  metamask: metamaskLogo,
  coinbase: coinbaseLogo,
};

export const WALLET_LABELS: Record<string, string> = {
  phantom: "Phantom",
  metamask: "MetaMask",
  coinbase: "Coinbase Wallet",
  bitget: "Bitget Wallet",
  trust: "Trust Wallet",
  rainbow: "Rainbow",
  walletconnect: "WalletConnect",
};

/** Returns a logo URL for the given wallet provider id, or undefined. */
export function walletLogo(provider: string): string | undefined {
  return WALLET_LOGOS[provider.toLowerCase()];
}

export function walletLabel(provider: string): string {
  const key = provider.toLowerCase();
  return WALLET_LABELS[key] ?? provider;
}
