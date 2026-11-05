export type ExchangeWalletIdentity = {
  connection_id: string;
  exchange: string;
  account_address: string | null;
};
type Wallet = {
  id: string;
  public_address: string;
  status: string;
  is_active?: boolean;
  assigned_exchange_connection_id?: string | null;
};

/** One verified wallet may own several exchange accounts. Never guess by count/provider. */
export function accountWallets<T extends Wallet>(
  wallets: T[],
  connectionId: string,
  identities: ExchangeWalletIdentity[],
): T[] {
  const address = identities.find((row) => row.connection_id === connectionId)?.account_address;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return [];
  return wallets.filter(
    (wallet) =>
      wallet.is_active !== false &&
      wallet.status === "verified" &&
      wallet.public_address.toLowerCase() === address.toLowerCase(),
  );
}

export function connectedWallets<T extends Wallet>(
  wallets: T[],
  connectionId: string,
  identities: ExchangeWalletIdentity[],
): T[] {
  const matched = accountWallets(wallets, connectionId, identities);
  // An account-address match is stronger than a manually assigned funding label.
  const knownAddress = identities.some(
    (row) => row.connection_id === connectionId && row.account_address,
  );
  return knownAddress
    ? matched
    : wallets.filter(
        (wallet) =>
          wallet.is_active !== false && wallet.assigned_exchange_connection_id === connectionId,
      );
}
