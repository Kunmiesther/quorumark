/**
 * Scout schema/rules version constants. Bump when the shape or the deterministic
 * rules that produce evidence/state/outcome change. Persisted with every row so
 * we can filter/replay coherent training data later.
 *
 * READ-ONLY MODULE. See `scout-no-execution-imports.test.ts`.
 */
export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const STATE_SCHEMA_VERSION = 1 as const;
export const OUTCOME_SCHEMA_VERSION = 1 as const;
export const RULES_VERSION = 1 as const;

export interface VersionTag {
  evidence_schema_version: number;
  rules_version: number;
}

export const CURRENT_VERSION_TAG: VersionTag = {
  evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
  rules_version: RULES_VERSION,
};
