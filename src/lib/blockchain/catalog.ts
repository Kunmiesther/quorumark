/** Networks are not exchanges. These entries never grant an execution capability. */
export const BLOCKCHAINS = [
  {
    id: "base",
    name: "Base",
    family: "evm",
    chainId: 8453,
    gas: "ETH",
    decimals: 18,
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org/address/",
    docs: "https://docs.base.org/chain/network-information",
    accent: "#0052FF",
    route: "Uniswap v3 wallet swaps · ETH ↔ USDC · SynFutures perpetuals separate",
  },
  {
    id: "solana",
    name: "Solana",
    family: "solana",
    chainId: null,
    gas: "SOL",
    decimals: 9,
    rpc: "https://api.mainnet-beta.solana.com",
    explorer: "https://explorer.solana.com/address/",
    docs: "https://solana.com/docs/references/clusters",
    accent: "#14F195",
    route: "Spot swap router not connected",
  },
  {
    id: "robinhood",
    name: "Robinhood Chain",
    family: "evm",
    chainId: 4663,
    gas: "ETH",
    decimals: 18,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com/address/",
    docs: "https://docs.robinhood.com/chain/add-network-to-wallet/",
    accent: "#CCFF00",
    route: "On-chain trading router not connected · not Robinhood brokerage",
  },
  {
    id: "bnb",
    name: "BNB Smart Chain",
    family: "evm",
    chainId: 56,
    gas: "BNB",
    decimals: 18,
    rpc: "https://bsc-dataseed.bnbchain.org",
    explorer: "https://bscscan.com/address/",
    docs: "https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/",
    accent: "#F0B90B",
    route: "Uniswap v3 wallet swaps · BNB ↔ Binance-pegged USDT · not Binance exchange",
  },
] as const;
export type BlockchainId = (typeof BLOCKCHAINS)[number]["id"];
export type Blockchain = (typeof BLOCKCHAINS)[number];
export type NetworkWallet = {
  id: string;
  chain: string;
  network: string;
  public_address: string;
  status: string;
  is_active: boolean;
  provider: string;
  label: string | null;
};

export function isSolanaAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (value > 0n) {
    bytes++;
    value >>= 8n;
  }
  return bytes + (address.match(/^1*/)?.[0].length ?? 0) === 32;
}

export function walletSupportsNetwork(wallet: NetworkWallet, network: Blockchain): boolean {
  if (!wallet.is_active || wallet.status !== "verified" || wallet.network !== "mainnet")
    return false;
  return network.family === "evm"
    ? wallet.chain === "ethereum" && /^0x[0-9a-fA-F]{40}$/.test(wallet.public_address)
    : wallet.chain === "solana" && isSolanaAddress(wallet.public_address);
}
