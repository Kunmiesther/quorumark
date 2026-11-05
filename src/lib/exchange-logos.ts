// Only allowlisted CEX logos. Keep in sync with src/lib/supported-exchanges.ts.
import coinbase from "@/assets/wallets/official/coinbase.svg";
import kraken from "@/assets/exchanges/kraken.svg";

export const EXCHANGE_LOGOS: Record<string, string> = {
  coinbase,
  kraken,
};

export function exchangeLogo(id: string): string | undefined {
  return EXCHANGE_LOGOS[id.toLowerCase()];
}
