// Central registry for Turtle Bot character/hero images.
// Every page should pull its top hero/background image from here so we have
// one source of truth. Add new characters by dropping the .webp.asset.json
// pointer in src/assets/characters/ and adding an entry below.

import scout from "@/assets/characters/scout.webp.asset.json";
import phantom from "@/assets/characters/phantom.webp.asset.json";
import oracle from "@/assets/characters/oracle.webp.asset.json";
import vanguard from "@/assets/characters/vanguard.webp.asset.json";
import inferno from "@/assets/characters/inferno.webp.asset.json";
import nomad from "@/assets/characters/nomad.webp.asset.json";
import shadow from "@/assets/characters/shadow.webp.asset.json";
import aster from "@/assets/characters/aster.webp.asset.json";
import warden from "@/assets/characters/warden.webp.asset.json";

export type CharacterKey =
  | "scout"
  | "phantom"
  | "oracle"
  | "vanguard"
  | "inferno"
  | "nomad"
  | "shadow"
  | "aster"
  | "warden";

export interface CharacterAsset {
  key: CharacterKey;
  name: string;
  tagline: string;
  accent: string; // dominant color, useful for accent gradients
  url: string;
}

export const CHARACTERS: Record<CharacterKey, CharacterAsset> = {
  scout:    { key: "scout",    name: "Scout 4/5",  tagline: "Signal Recon",        accent: "#22d3ee", url: scout.url },
  phantom:  { key: "phantom",  name: "Phantom",    tagline: "Stealth Executor",    accent: "#a855f7", url: phantom.url },
  oracle:   { key: "oracle",   name: "Oracle",     tagline: "Market Intelligence", accent: "#eab308", url: oracle.url },
  vanguard: { key: "vanguard", name: "Vanguard",   tagline: "Risk Shield",         accent: "#3b82f6", url: vanguard.url },
  inferno:  { key: "inferno",  name: "Inferno",    tagline: "Momentum Strike",     accent: "#ef4444", url: inferno.url },
  nomad:    { key: "nomad",    name: "Nomad",      tagline: "Long-Range Scout",    accent: "#d4a373", url: nomad.url },
  shadow:   { key: "shadow",   name: "Shadow",     tagline: "Dark Pool Ops",       accent: "#8b5cf6", url: shadow.url },
  aster:    { key: "aster",    name: "Aster",      tagline: "Ground Breaker",      accent: "#f59e0b", url: aster.url },
  warden:   { key: "warden",   name: "Warden",     tagline: "Defense Grid",        accent: "#dc2626", url: warden.url },
};

// Default character used at the top of each page unless overridden.
export const PAGE_HERO: Record<string, CharacterKey> = {
  home: "scout",
  trade: "oracle",
  portfolio: "vanguard",
  signals: "phantom",
  history: "nomad",
  settings: "warden",
  strategy: "inferno",
  intel: "shadow",
  arena: "aster",
};

export function getCharacter(key: CharacterKey): CharacterAsset {
  return CHARACTERS[key];
}

export function getPageHero(page: keyof typeof PAGE_HERO | string): CharacterAsset {
  const key = (PAGE_HERO as Record<string, CharacterKey>)[page] ?? "scout";
  return CHARACTERS[key];
}
