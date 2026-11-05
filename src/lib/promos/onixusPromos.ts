/**
 * Onixus house-promo board config.
 *
 * Render ALL entries with `enabled: true`. Disabled entries stay in the
 * file so they can be swapped in later by flipping the flag. Keep copy
 * honest — no metrics, no testimonials.
 *
 * URLs marked `verified: false` are placeholders — owner must confirm
 * or supply the real link before the entry can honestly point somewhere.
 */

export type PromoBadge = "LIVE" | "BETA" | "NEW";

export interface OnixusPromo {
  id: string;
  name: string;
  tagline: string;
  description?: string;
  url: string;
  accent: string;
  badge?: PromoBadge;
  /** Optional hero image sourced from the destination site. */
  image?: string;
  /** Compact brand mark used in the clickable visit control. */
  logo?: string;
  enabled: boolean;
  /** Whether the URL has been owner-verified. UI does not display this flag. */
  verified: boolean;
}

import shadowCityHero from "@/assets/promos/shadowcity-hero.png.asset.json";

export const ONIXUS_PROMOS: OnixusPromo[] = [
  // Wojo stays off the live board until it has a real, owner-verified URL.
  // A placeholder href must never look like a working advertisement.
  {
    id: "wojo",
    name: "Wojo",
    tagline: "Coming soon.",
    url: "#",
    accent: "#4FD1C5",
    badge: "NEW",
    enabled: false,
    verified: false,
  },
  {
    id: "shadow-city-novels",
    name: "Shadow City Novels",
    tagline: "Enter Shadow City.",
    description: "The Wolf Gang: Adzeli universe by Skilachi.",
    url: "https://www.shadowcitynovels.xyz/",
    accent: "#EC4899",
    badge: "NEW",
    image: shadowCityHero.url,
    logo: "https://www.shadowcitynovels.xyz/favicon.ico",
    enabled: true,
    verified: true,
  },
  {
    id: "liveaskew",
    name: "LiveAskew",
    tagline: "Your AI stylist.",
    url: "https://liveaskew.com/",
    accent: "#F59E0B",
    badge: "BETA",
    image:
      "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/9bf1e19c-c973-4cd4-8889-e3c6de97d021/id-preview-b526b163--59a668ac-393a-421f-8c9e-80dcaad58378.lovable.app-1780610952943.png",
    logo: "https://liveaskew.com/favicon.ico",
    enabled: true,
    verified: true,
  },
  {
    id: "zeevents",
    name: "Zeevents.xyz",
    tagline: "AI event planning.",
    url: "https://zeevents.xyz/",
    accent: "#22D3EE",
    badge: "BETA",
    image: "https://zeevents.xyz/zee-og.jpg",
    logo: "https://zeevents.xyz/favicon.ico",
    enabled: true,
    verified: true,
  },
  {
    id: "onixus",
    name: "Onixus",
    tagline: "AI that runs your business.",
    url: "https://www.onixus.xyz/",
    accent: "#9945FF",
    badge: "BETA",
    image: "https://onixus.xyz/__l5e/assets-v1/6ff532a2-ebd4-4f48-9f37-d59ae4890c90/onyx-head.png",
    logo: "/assets/onyx-head.webp",
    enabled: true,
    verified: true,
  },

  // ---- Reserve bench (not rendered) — flip enabled:true to swap in ----
  {
    id: "shadow-city-supply",
    name: "Shadow City Supply Co.",
    tagline: "Wear the universe.",
    url: "https://shadowcitysupply.com",
    accent: "#F59E0B",
    enabled: false,
    verified: false,
  },
];

export function getVisiblePromos(): OnixusPromo[] {
  return ONIXUS_PROMOS.filter((p) => p.enabled && p.verified && p.url !== "#");
}
