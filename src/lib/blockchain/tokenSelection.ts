/** Navigation only. A discovered address is not a verified token or an executable route. */
export function tokenSwapLink(chain: string, address: string): string | null {
  const network = chain === "bsc" ? "bnb" : chain;
  if (!["base", "bnb"].includes(network) || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return `/exchanges?swapNetwork=${network}&swapToken=${address.toLowerCase()}#blockchain-${network}`;
}

export function tokenFromSearch(search: string, network: string): string {
  const params = new URLSearchParams(search);
  const address = params.get("swapToken") ?? "";
  return params.get("swapNetwork") === network && /^0x[0-9a-fA-F]{40}$/.test(address)
    ? address.toLowerCase()
    : "";
}
