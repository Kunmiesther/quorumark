/** Paper roles are separate accounting buckets, not wallet connections. */
export const PAPER_PORTFOLIO_WALLETS = [
  { key: "long", label: "Long", blockchain: false, provider: "metamask" },
  { key: "short", label: "Short", blockchain: false, provider: "trust" },
  { key: "hedge", label: "Hedge", blockchain: false, provider: "coinbase" },
  { key: "strategy", label: "Strategy", blockchain: false, provider: "binance" },
  { key: "blockchain_evm", label: "Blockchain · EVM", blockchain: true, provider: "metamask" },
  {
    key: "blockchain_non_evm",
    label: "Blockchain · non-EVM",
    blockchain: true,
    provider: "phantom",
  },
] as const;
export const PAPER_WALLET_SEED_USD = 2500;
export const PAPER_WALLET_PROVIDERS = {
  metamask: "MetaMask",
  trust: "Trust Wallet",
  coinbase: "Coinbase Wallet",
  phantom: "Phantom",
  solflare: "Solflare",
  binance: "Binance Wallet",
  robinhood: "Robinhood Wallet",
} as const;

export function paperWalletFunds(balance: unknown, reserved: unknown) {
  const settled = balance == null ? NaN : Number(balance);
  const margin = reserved == null ? NaN : Number(reserved);
  if (!Number.isFinite(settled) || !Number.isFinite(margin) || margin < 0) return null;
  return { settled, reserved: margin, available: Math.max(0, settled - margin) };
}

export function paperTicketAvailable(
  accountAvailable: number,
  walletBalance: unknown,
  reserved: number,
) {
  const funds = paperWalletFunds(walletBalance, reserved);
  return funds && Number.isFinite(accountAvailable)
    ? Math.max(0, Math.min(accountAvailable, funds.available))
    : null;
}
