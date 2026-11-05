import type { WalletProviderId } from "@/lib/wallet/providers";

import bitgetLogo from "@/assets/wallets/official/bitget.svg";
import coinbaseLogo from "@/assets/wallets/official/coinbase.svg";
import metamaskLogo from "@/assets/wallets/official/metamask.svg";
import phantomLogo from "@/assets/wallets/official/phantom.svg";
import rainbowLogo from "@/assets/wallets/official/rainbow.svg";
import trustLogo from "@/assets/wallets/official/trust.svg";
import walletConnectLogo from "@/assets/wallets/official/walletconnect.svg";

const WALLET_LOGOS: Record<WalletProviderId, { src: string; label: string }> = {
  phantom: { src: phantomLogo, label: "Phantom" },
  coinbase: { src: coinbaseLogo, label: "Coinbase Wallet" },
  bitget: { src: bitgetLogo, label: "Bitget Wallet" },
  metamask: { src: metamaskLogo, label: "MetaMask" },
  trust: { src: trustLogo, label: "Trust Wallet" },
  rainbow: { src: rainbowLogo, label: "Rainbow" },
  walletconnect: { src: walletConnectLogo, label: "WalletConnect" },
};

export function WalletMark({ id }: { id: WalletProviderId }) {
  const wallet = WALLET_LOGOS[id];

  return (
    <img
      src={wallet.src}
      alt={`${wallet.label} logo`}
      className="block h-full w-full shrink-0 rounded-full object-cover"
      draggable={false}
    />
  );
}
