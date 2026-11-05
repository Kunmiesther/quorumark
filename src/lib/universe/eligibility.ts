/**
 * Fail-closed eligibility filter.
 *
 * Every instrument returned by an adapter is checked against the versioned
 * eligibility config. Missing / unverified / stale inputs are always
 * rejected — the filter NEVER assumes "probably fine". Every rejection
 * carries at least one machine-readable reason code so the UI can explain
 * why a symbol is not tradable.
 */
import type {
  EligibilityConfig,
  EligibleSymbol,
  ResolvedOverride,
  VerifiedInstrument,
  VerifiedUniverse,
} from "./types";
import { UNIVERSE_VERSION } from "./versions";

/**
 * Conservative defaults. Anything smaller than "recent, liquid perp" fails.
 * Bump UNIVERSE_VERSION when the shape / weights of this config change.
 */
export const DEFAULT_ELIGIBILITY: EligibilityConfig = {
  version: UNIVERSE_VERSION,
  maxAgeMs: 10 * 60_000,             // 10 minutes
  minVolumeUsd: 5_000_000,           // $5M 24h notional
  maxSpreadBps: 25,                  // ≤ 0.25%
  minExchangeMaxLeverage: 5,
  requireFields: [
    "maxLeverage",
    "tickSize",
    "minQty",
    "minNotional",
    "volume24hUsd",
  ],
};

function checkOne(
  inst: VerifiedInstrument,
  cfg: EligibilityConfig,
  now: number,
): EligibleSymbol {
  const reasons: string[] = [];

  if (!inst.tradable) reasons.push("not_tradable");
  if (inst.ageMs > cfg.maxAgeMs) reasons.push("metadata_stale");

  for (const field of cfg.requireFields) {
    const v = inst[field];
    if (v == null) reasons.push(`missing_${String(field)}`);
  }

  if (inst.maxLeverage != null && inst.maxLeverage < cfg.minExchangeMaxLeverage) {
    reasons.push("leverage_below_min");
  }
  if (inst.volume24hUsd != null && inst.volume24hUsd < cfg.minVolumeUsd) {
    reasons.push("liquidity_below_min");
  }
  if (inst.spreadBps != null && inst.spreadBps > cfg.maxSpreadBps) {
    reasons.push("spread_above_max");
  }
  if (inst.minNotional != null && inst.minNotional < 0) {
    reasons.push("invalid_min_notional");
  }
  if (inst.tickSize != null && inst.tickSize <= 0) {
    reasons.push("invalid_tick_size");
  }

  void now; // reserved for future funding-window / maintenance-window checks

  return { instrument: inst, eligible: reasons.length === 0, reasons };
}

/**
 * Apply eligibility filter + owner overrides.
 * Precedence: emergency_allow > deny > allow > (natural filter result).
 */
export function filterEligibility(
  universe: VerifiedUniverse,
  overrides: ResolvedOverride[],
  cfg: EligibilityConfig = DEFAULT_ELIGIBILITY,
  now = Date.now(),
): EligibleSymbol[] {
  const overrideMap = new Map<string, ResolvedOverride>();
  for (const o of overrides) overrideMap.set(o.symbol, o);

  return universe.instruments.map((inst) => {
    const base = checkOne(inst, cfg, now);
    const ov = overrideMap.get(inst.symbol);
    if (!ov) return base;
    if (ov.effective === "force_exclude") {
      return {
        instrument: inst,
        eligible: false,
        reasons: [...base.reasons, `override_${ov.source ?? "deny"}`],
      };
    }
    if (ov.effective === "force_include") {
      // Emergency allowlist bypass — still tag the reason so the UI can flag it.
      return {
        instrument: inst,
        eligible: true,
        reasons: [`override_${ov.source ?? "emergency_allow"}`],
      };
    }
    return base;
  });
}
