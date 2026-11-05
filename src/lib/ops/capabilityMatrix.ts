/**
 * Strategy / role capability contract. This is the SINGLE source of truth
 * for "what is each subsystem actually allowed to do?" — do not invent
 * capabilities anywhere else.
 *
 * READ-ONLY / PURE. Consumed by the ops panel, tests, and manifests.
 */

export type Capability =
  | "detect"
  | "recommend"
  | "decide"
  | "open"
  | "add_rung"
  | "close"
  | "hedge"
  | "learn"
  | "sign_live_order";

export interface RoleContract {
  id: string;
  role: "scout" | "onyx" | "strategy" | "product";
  capabilities: Capability[];
  /** Human summary shown in the ops panel. */
  summary: string;
  /** Explicit hard denials — must never be violated. */
  denies: Capability[];
}

/**
 * Global capability matrix. If a subsystem is missing here, it has NO
 * approved capabilities. Nothing else is implicitly authorized.
 */
export const CAPABILITY_MATRIX: readonly RoleContract[] = [
  {
    id: "scout",
    role: "scout",
    capabilities: ["detect", "recommend"],
    summary:
      "Observe, detect, and transfer intelligence. Independently evaluates long and short opportunities across M/W/D/4H/1H/15M/5M.",
    denies: ["open", "add_rung", "close", "hedge", "decide", "sign_live_order"],
  },
  {
    id: "onyx",
    role: "onyx",
    capabilities: ["decide", "recommend", "learn"],
    summary:
      "Consumes fresh, version-compatible Scout envelopes. Persists every decision with timing + rejection reasons. May authorize intents only when every guard passes; the private signer owns live signing.",
    denies: ["detect", "sign_live_order"],
  },
  {
    id: "accumulator",
    role: "strategy",
    capabilities: ["open", "add_rung", "close"],
    summary:
      "DCA / laddered position. Global final-rung stop invariant applies to every symbol whose position is explicitly ladder/DCA.",
    denies: ["sign_live_order", "detect", "hedge"],
  },
  {
    id: "dca",
    role: "strategy",
    capabilities: ["open", "add_rung", "close"],
    summary:
      "Alias of accumulator contract. Same ladder invariant, same denies.",
    denies: ["sign_live_order", "detect", "hedge"],
  },
  {
    id: "vanguard",
    role: "strategy",
    capabilities: ["open", "close"],
    summary: "Break-and-retest trend strategy. Strategy stops apply; this is not an Accumulator ladder.",
    denies: ["add_rung", "sign_live_order", "detect", "hedge"],
  },
  {
    id: "sweep",
    role: "strategy",
    capabilities: ["open", "add_rung", "close"],
    summary: "Zen Sweep campaign strategy inside a selected Accumulator or Sniper. Paper lifecycle supported; live campaign parity remains blocked.",
    denies: ["sign_live_order", "detect", "hedge"],
  },
  {
    id: "hunter",
    role: "strategy",
    capabilities: ["open", "close"],
    summary:
      "High-volatility specialist. Not a ladder — normal strategy-level stops remain active.",
    denies: ["add_rung", "sign_live_order", "detect", "hedge"],
  },
  {
    id: "sniper",
    role: "strategy",
    capabilities: ["open", "close"],
    summary:
      "Precision zone-reversal. Not a ladder — normal strategy-level stops remain active.",
    denies: ["add_rung", "sign_live_order", "detect", "hedge"],
  },
  {
    id: "arbiter",
    role: "strategy",
    capabilities: [],
    summary:
      "Arbitrage execution Turtle. Autonomous coordinated arbitrage and blockchain momentum lifecycles are not implemented.",
    denies: ["open", "add_rung", "close", "sign_live_order", "detect", "hedge"],
  },
  {
    id: "fusion",
    role: "product",
    capabilities: [],
    summary:
      "Product surface only. NOT a local trading strategy — never opens, adds, or closes positions.",
    denies: ["open", "add_rung", "close", "decide", "sign_live_order", "detect", "hedge"],
  },
] as const;

/** Ladder-owning strategy IDs — must match `src/lib/paper/ladder-policy.ts`. */
export const LADDER_STRATEGY_IDS = new Set(["accumulator", "dca"]);

export function getContract(id: string): RoleContract | undefined {
  return CAPABILITY_MATRIX.find((c) => c.id === id);
}

export function isAllowed(id: string, cap: Capability): boolean {
  const c = getContract(id);
  if (!c) return false;
  if (c.denies.includes(cap)) return false;
  return c.capabilities.includes(cap);
}
