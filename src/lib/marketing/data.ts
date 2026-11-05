// Shared marketing content. Text is deliberately conservative — no fabricated
// performance numbers, no fake partners, no fake pricing. Anything not yet live
// is labeled Planned / In Development / Coming Soon / Target.

import turtleScoutAsset from "@/assets/characters/scout.webp.asset.json";
import turtleOnyxAsset from "@/assets/onyx-head.png.asset.json";
import turtleWardenAsset from "@/assets/lifemap-arbiter.png.asset.json";
import turtleVanguardAsset from "@/assets/lifemap-vanguard.png.asset.json";
import turtleShadowAsset from "@/assets/characters/shadow.webp.asset.json";
import turtleInfernoAsset from "@/assets/characters/inferno.webp.asset.json";
import turtleOracleAsset from "@/assets/characters/oracle.webp.asset.json";
import turtleAsterAsset from "@/assets/characters/aster.webp.asset.json";
import turtleNomadAsset from "@/assets/characters/nomad.webp.asset.json";
import turtlePhantomAsset from "@/assets/characters/phantom.webp.asset.json";
import turtleFusionAsset from "@/assets/characters/fusion.png.asset.json";
import turtleRedLavaAsset from "@/assets/characters/turtle-red-lava.png.asset.json";
import turtleTradeHeroAsset from "@/assets/characters/trade-hero.png.asset.json";
import homeHeroAsset from "@/assets/home-hero.png.asset.json";
import collectibleAsset from "@/assets/turtlebot-collectible-2027.png.asset.json";
import wordmarkAsset from "@/assets/turtlebot-wordmark.png.asset.json";
import bgLifeMapAsset from "@/assets/bg-life-map.png.asset.json";
import lifeMapScoutAsset from "@/assets/lifemap-scout.png.asset.json";
import lifeMapHunterAsset from "@/assets/lifemap-hunter.png.asset.json";
import lifeMapSniperAsset from "@/assets/lifemap-sniper.png.asset.json";
import lifeMapVanguardAsset from "@/assets/lifemap-vanguard.png.asset.json";
import lifeMapArbiterAsset from "@/assets/lifemap-arbiter.png.asset.json";
import lifeMapAccumulatorAsset from "@/assets/lifemap-accumulator.png.asset.json";

export const brand = {
  wordmark: wordmarkAsset.url,
  homeHero: homeHeroAsset.url,
  tradeHero: turtleTradeHeroAsset.url,
  redLava: turtleRedLavaAsset.url,
  collectible: collectibleAsset.url,
  onyxHead: turtleOnyxAsset.url,
  bgLifeMap: bgLifeMapAsset.url,
};

export const lifeMapPortraits = {
  scout: lifeMapScoutAsset.url,
  hunter: lifeMapHunterAsset.url,
  sniper: lifeMapSniperAsset.url,
  vanguard: lifeMapVanguardAsset.url,
  arbiter: lifeMapArbiterAsset.url,
  accumulator: lifeMapAccumulatorAsset.url,
};

export type TurtleRole = {
  key: string;
  name: string;
  role: string;
  tagline: string;
  description: string;
  status: "Live" | "Live in paper" | "In development" | "Planned";
  portrait: string;
  accent: "cyan" | "violet" | "emerald" | "amber" | "rose" | "gold";
};

export const turtleCollective: TurtleRole[] = [
  {
    key: "scout",
    name: "Scout",
    role: "Reconnaissance & signal intelligence",
    tagline: "Scans exchanges, symbols and timeframes for structure that matters.",
    description:
      "Scout rotates through the eligible futures universe, evaluates multi-timeframe market structure, and streams compact evidence into the intelligence layer. Read-only by design — Scout never places orders.",
    status: "Live",
    portrait: turtleScoutAsset.url,
    accent: "cyan",
  },
  {
    key: "onyx",
    name: "Onyx",
    role: "Intelligence & decision commander",
    tagline: "Weighs Scout evidence, portfolio state and guardrails.",
    description:
      "Onyx reasons over the full field of options every minute, records its decisions with rationale, and coordinates offense and defense. Currently drives the paper engine and shadows every real-world path.",
    status: "Live in paper",
    portrait: turtleOnyxAsset.url,
    accent: "violet",
  },
  {
    key: "warden",
    name: "Warden",
    role: "Risk, guardrails & kill switches",
    tagline: "The last line before capital moves.",
    description:
      "Warden enforces cross-margin limits, per-symbol caps, drawdown floors, kill switches and human overrides. Every proposed action is preflighted against Warden before execution is allowed.",
    status: "Live",
    portrait: turtleWardenAsset.url,
    accent: "amber",
  },
  {
    key: "vanguard",
    name: "Vanguard",
    role: "Executor / offense",
    tagline: "Turns approved intent into precise, auditable orders.",
    description:
      "Vanguard converts approved strategy decisions into laddered limit-maker entries and symmetric take-profit exits. Executes only what Onyx approves and Warden allows, and only at the venues you connected.",
    status: "Live in paper",
    portrait: turtleVanguardAsset.url,
    accent: "emerald",
  },
  {
    key: "shadow",
    name: "Shadow",
    role: "Defense & structure watcher",
    tagline: "Watches open positions for break-of-structure.",
    description:
      "Shadow monitors open positions on a shorter timeframe than the entry and flags adverse BOS. Onyx uses those flags to exit positions before a stop-out becomes forced.",
    status: "Live in paper",
    portrait: turtleShadowAsset.url,
    accent: "cyan",
  },
  {
    key: "sentinel",
    name: "Sentinel",
    role: "Ops & health",
    tagline: "Watches the system that watches the markets.",
    description:
      "Sentinel snapshots component health for Scout, Onyx, Vanguard and connectors — freshness, backlog, latency and last success. Publishes to the ops dashboard so you always know what's actually running.",
    status: "Live",
    portrait: turtleInfernoAsset.url,
    accent: "rose",
  },
  {
    key: "oracle",
    name: "Oracle",
    role: "Life Map planning",
    tagline: "Ties earnings to goals with purpose.",
    description:
      "Oracle helps you translate realized net earnings into progress against real goals — bills, emergency savings, education, family plans. Progress is verified against your actual account activity.",
    status: "In development",
    portrait: turtleOracleAsset.url,
    accent: "gold",
  },
  {
    key: "aster",
    name: "Aster",
    role: "Signal community",
    tagline: "Turns intelligence into insight you can share.",
    description:
      "Aster is the planned Signal layer that publishes selected Scout and Onyx observations for the community — always distinguishing observation from recommendation.",
    status: "Planned",
    portrait: turtleAsterAsset.url,
    accent: "violet",
  },
];

export type EcosystemNode = {
  key: string;
  label: string;
  status: "Live" | "In development" | "Planned";
  description: string;
};

export const ecosystemNodes: EcosystemNode[] = [
  {
    key: "bot",
    label: "TurtleBot Core",
    status: "Live",
    description: "Scout, Onyx, Warden, Vanguard and Shadow coordinated in a single engine.",
  },
  {
    key: "wallet",
    label: "Non-Custodial Wallet Connect",
    status: "Live",
    description: "Connect self-custody wallets you already own — TurtleBot never holds your keys.",
  },
  {
    key: "life-map",
    label: "Life Map",
    status: "In development",
    description: "Goal-based financial planning grounded in verified earnings.",
  },
  {
    key: "signal",
    label: "Signal",
    status: "Planned",
    description: "Community feed of Scout & Onyx observations — labeled, not prescriptive.",
  },
  {
    key: "nft",
    label: "NFT Access",
    status: "Planned",
    description: "Genesis and Evolution collections that unlock ecosystem utility.",
  },
  {
    key: "market",
    label: "Marketplace / Merch",
    status: "Planned",
    description: "Turtle-branded goods and collector items.",
  },
  {
    key: "token",
    label: "Token Utility",
    status: "Planned",
    description: "Utility token targeted for launch approximately 12 months out.",
  },
  {
    key: "gov",
    label: "Community Governance",
    status: "Planned",
    description: "Broader stakeholder governance for ecosystem evolution.",
  },
];

export type RoadmapPhase = {
  phase: string;
  title: string;
  status: "Complete" | "In progress" | "Next" | "Planned" | "Target";
  window: string;
  bullets: string[];
};

export const roadmapPhases: RoadmapPhase[] = [
  {
    phase: "Phase 1",
    title: "Foundation",
    status: "Complete",
    window: "2025 → 2026 H1",
    bullets: [
      "Core dashboard, authentication and profile system",
      "Exchange & wallet framework (non-custodial handshake)",
      "Scout / Onyx architecture in place",
      "Life Map foundation",
    ],
  },
  {
    phase: "Phase 2",
    title: "Intelligence",
    status: "In progress",
    window: "2026 H2",
    bullets: [
      "Four-symbol scanning across BTC, XRP, SOL, and ETH",
      "Multi-timeframe analysis and evidence persistence",
      "Onyx decision commander with audit trail",
      "Risk, permissions and kill-switch systems",
    ],
  },
  {
    phase: "Phase 3",
    title: "Internal Live Validation",
    status: "Next",
    window: "Target 2026 → 2027",
    bullets: [
      "Company-only live execution testing; no public live-trading test access",
      "Transparent execution records for every trade",
      "Expanded exchange coverage",
      "Human override and pause controls surfaced everywhere",
    ],
  },
  {
    phase: "Phase 4",
    title: "Ecosystem",
    status: "Planned",
    window: "Target 2027",
    bullets: [
      "Expanded non-custodial wallet coverage",
      "Signal community layer",
      "Marketplace foundation",
      "Community programs and creator tooling",
    ],
  },
  {
    phase: "Phase 5",
    title: "Genesis NFT Drop",
    status: "Planned",
    window: "Target 2027",
    bullets: [
      "Genesis Turtles founding collection",
      "Character identity + ecosystem access",
      "Community benefits framework",
    ],
  },
  {
    phase: "Phase 6",
    title: "Utility Expansion & Evolution Drop",
    status: "Planned",
    window: "Target 2027",
    bullets: [
      "Evolution Armor collection",
      "Expanded ecosystem utility for holders",
      "Deeper Life Map integration",
    ],
  },
  {
    phase: "Phase 7",
    title: "Token Launch",
    status: "Target",
    window: "Target July 2027 (approx. 12 months out)",
    bullets: [
      "Utility token launch, subject to jurisdiction and compliance review",
      "Distribution framework published in advance",
      "Not an offer or guarantee of allocation",
    ],
  },
  {
    phase: "Phase 8",
    title: "Governance & Expansion",
    status: "Planned",
    window: "Target 2027+",
    bullets: [
      "Stakeholder governance for major decisions",
      "Third-party integrations & partnerships",
      "Broader financial planning surface",
    ],
  },
];

export const additionalAssets = {
  fusion: turtleFusionAsset.url,
  nomad: turtleNomadAsset.url,
  phantom: turtlePhantomAsset.url,
};

export const brandLines = {
  primary: "AI is changing how people work. TurtleBot is changing who AI works for.",
  everyday: "Built for everyday people. Powerful enough for traders.",
  purpose: "Your progress should have a purpose.",
  thrive:
    "We do not build AI to replace people. We build AI to help people thrive in an AI-powered world.",
};

export const riskDisclosure =
  "Digital assets and automated trading involve substantial risk of loss. Outcomes are not guaranteed. Nothing on this site is financial, legal or tax advice. Only participate with capital you can afford to lose.";
