import type { Address } from "viem";

/** Entry screen, NOT proof of future sellability. Missing evidence is not safe evidence. */
export function tokenSecurityBlockers(report: Record<string, unknown> | null): string[] {
  if (!report) return ["Token security evidence is unavailable; retry before buying this token."];
  const expected: Record<string, string> = {
    is_open_source: "1",
    is_in_dex: "1",
    is_proxy: "0",
    is_honeypot: "0",
    cannot_buy: "0",
    cannot_sell_all: "0",
    transfer_pausable: "0",
    is_blacklisted: "0",
    is_whitelisted: "0",
    slippage_modifiable: "0",
    owner_change_balance: "0",
    hidden_owner: "0",
    can_take_back_ownership: "0",
    selfdestruct: "0",
    external_call: "0",
    is_mintable: "0",
    anti_whale_modifiable: "0",
    trading_cooldown: "0",
  };
  const blockers = Object.entries(expected).flatMap(([key, value]) =>
    report[key] === value
      ? []
      : [
          `Token entry screen: ${key} is ${report[key] === undefined || report[key] === null ? "unknown" : "not cleared"}.`,
        ],
  );
  // The current v3 route does not support fee-on-transfer tokens. Empty tax
  // data is unknown, not zero. Never silently compensate by widening slippage.
  for (const field of ["buy_tax", "sell_tax", "transfer_tax"]) {
    const value = report[field];
    if (typeof value !== "string" || value.trim() === "" || Number(value) !== 0)
      blockers.push(`Token entry screen: ${field} must be verified zero for this router.`);
  }
  return blockers;
}

/** Only public chain/contract identity leaves the server; never wallet credentials. */
export async function readTokenSecurity(chainId: number, address: Address, fetcher = fetch) {
  if (![8453, 56].includes(chainId)) return null;
  try {
    const response = await fetcher(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`,
      { signal: AbortSignal.timeout(8_000), redirect: "error", cache: "no-store" },
    );
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.code !== 1) return null;
    const report = body?.result?.[address.toLowerCase()];
    return report && typeof report === "object" && !Array.isArray(report)
      ? (report as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
