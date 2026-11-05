// Venue logo registry. Only official/allowlisted assets.
// - CEX/Spot exchanges: bundled assets under src/assets/exchanges/ and wallets/official/
// - DEX marks: official public assets under src/assets/brand/<venue>/
//   (sources recorded beside each asset)

import apexOmniLogoUrl from "@/assets/brand/apex-omni/apex-gorilla-mark.svg";
import asterLogoUrl from "@/assets/brand/aster/aster-mark.png";
import synFuturesLogoUrl from "@/assets/brand/synfutures/synfutures-mark.png";
import { EXCHANGE_LOGOS } from "@/lib/exchange-logos";

export const apexOmniLogo = apexOmniLogoUrl;

/** Returns a logo URL for the given venue id, or undefined if none. */
export function venueLogo(venueId: string): string | undefined {
  const id = venueId.toLowerCase();
  if (id === "apex_omni" || id === "apex" || id === "apex-omni") return apexOmniLogoUrl;
  if (id === "aster") return asterLogoUrl;
  if (id === "synfutures" || id === "syn_futures" || id === "syn-futures") {
    return synFuturesLogoUrl;
  }
  return EXCHANGE_LOGOS[id];
}

export const VENUE_LABELS: Record<string, string> = {
  coinbase: "Coinbase",
  kraken: "Kraken",
  apex_omni: "ApeX Omni",
  aster: "Aster",
  synfutures: "SynFutures",
};

export function venueLabel(venueId: string): string {
  return VENUE_LABELS[venueId.toLowerCase()] ?? venueId;
}
