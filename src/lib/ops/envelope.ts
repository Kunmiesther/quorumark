/**
 * Versioned Scout → Onyx signal envelope.
 *
 * READ-ONLY / PURE. No I/O, no imports from execution surfaces.
 *
 * Purpose: give Onyx a single typed boundary through which it receives
 * intelligence from Scout, with explicit freshness + version guards so
 * stale or version-incompatible envelopes cannot be consumed.
 */
import {
  EVIDENCE_SCHEMA_VERSION,
  RULES_VERSION,
} from "@/lib/scout/versions";

export const ENVELOPE_VERSION = 1 as const;

export type Regime = "trend" | "range" | "high_vol" | "unknown";

export interface EnvelopeExecutionFacts {
  /** Venue supports hedge-mode (needed for opposite-side ladder). */
  hedge_capable: boolean;
  /** Required upstream frames (H4/D) present and fresh. */
  required_context_fresh: boolean;
  /** Kill switch state observed at envelope creation. */
  kill_switch_active: boolean;
  /** Mainnet remains disabled — paper only. */
  mainnet_enabled: boolean;
}

export interface SignalEnvelope {
  envelope_version: number;
  evidence_schema_version: number;
  rules_version: number;
  scan_id: string;
  symbol: string;
  regime: Regime;
  long_score: number;
  short_score: number;
  supporting_codes: string[];
  conflicting_codes: string[];
  /** Timestamp of the latest closed candle used to produce the envelope. */
  data_ts: number;
  /** Server timestamp at envelope creation. */
  created_at: number;
  execution: EnvelopeExecutionFacts;
}

/** Freshness policy per timeframe presence — envelope-wide, in ms. */
export const MAX_ENVELOPE_AGE_MS = 90_000;

export type EnvelopeGuard =
  | { ok: true }
  | { ok: false; reason:
      | "ENVELOPE_VERSION_MISMATCH"
      | "EVIDENCE_SCHEMA_MISMATCH"
      | "RULES_VERSION_MISMATCH"
      | "ENVELOPE_STALE"
      | "REQUIRED_CONTEXT_STALE"
      | "MAINNET_ACTIVE"
      | "KILL_SWITCH_ACTIVE"; };

/**
 * Deterministic guard. Returns first failure reason (fail-closed order).
 * `nowMs` MUST be a server timestamp — never a client clock.
 */
export function guardEnvelope(env: SignalEnvelope, nowMs: number): EnvelopeGuard {
  if (env.envelope_version !== ENVELOPE_VERSION) {
    return { ok: false, reason: "ENVELOPE_VERSION_MISMATCH" };
  }
  if (env.evidence_schema_version !== EVIDENCE_SCHEMA_VERSION) {
    return { ok: false, reason: "EVIDENCE_SCHEMA_MISMATCH" };
  }
  if (env.rules_version !== RULES_VERSION) {
    return { ok: false, reason: "RULES_VERSION_MISMATCH" };
  }
  if (env.execution.mainnet_enabled) {
    return { ok: false, reason: "MAINNET_ACTIVE" };
  }
  if (env.execution.kill_switch_active) {
    return { ok: false, reason: "KILL_SWITCH_ACTIVE" };
  }
  if (!env.execution.required_context_fresh) {
    return { ok: false, reason: "REQUIRED_CONTEXT_STALE" };
  }
  const age = nowMs - env.created_at;
  if (!Number.isFinite(age) || age < 0 || age > MAX_ENVELOPE_AGE_MS) {
    return { ok: false, reason: "ENVELOPE_STALE" };
  }
  return { ok: true };
}

/** Build an envelope from raw parts. Pure — never touches I/O. */
export function buildEnvelope(input: {
  scan_id: string;
  symbol: string;
  regime: Regime;
  long_score: number;
  short_score: number;
  supporting_codes: string[];
  conflicting_codes: string[];
  data_ts: number;
  created_at: number;
  execution: EnvelopeExecutionFacts;
}): SignalEnvelope {
  return {
    envelope_version: ENVELOPE_VERSION,
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    rules_version: RULES_VERSION,
    ...input,
  };
}
