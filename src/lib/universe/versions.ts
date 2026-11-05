/**
 * Versioned identifiers for the dynamic market universe subsystem.
 *
 * Every persisted snapshot / ranking row carries these version numbers so
 * a stored decision can always be re-hydrated with the exact ruleset that
 * produced it. Bump when the eligibility filter, ranking formula, or
 * hysteresis policy changes shape.
 */

/** Eligibility filter ruleset version. Bump when thresholds or fields change. */
export const UNIVERSE_VERSION = 1;

/** Ranking formula version. Bump when score components or weights change. */
export const RANKING_VERSION = 1;

/** Rank-band hysteresis / cooldown policy version. */
export const HYSTERESIS_VERSION = 1;
