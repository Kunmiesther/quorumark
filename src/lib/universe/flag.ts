/**
 * DYNAMIC_UNIVERSE_ENABLED — paper-only feature flag for the dynamic
 * market-universe / Scout ranking / capacity resolver / ONYX approval
 * pipeline. Default OFF during C1/C2/C3 construction.
 *
 * Hard invariants (enforced here so a misconfigured env cannot cross them):
 *   - Only enable-able in the paper environment. Live/mainnet is refused
 *     regardless of env var. If a future turn flips this flag on for
 *     mainnet, it must be a code change PLUS a review — not an env flip.
 *   - Never returns true when process.env.DYNAMIC_UNIVERSE_ENABLED is unset.
 *   - Never returns true if execution mode is anything other than 'paper'.
 */

export type UniverseExecutionMode = "paper" | "testnet" | "mainnet";

export interface UniverseFlagContext {
  /** Execution mode of the caller. Only 'paper' may activate this flag. */
  executionMode: UniverseExecutionMode;
}

const RAW_ENV = "DYNAMIC_UNIVERSE_ENABLED";

function readEnvFlag(): boolean {
  const raw = typeof process !== "undefined" ? process.env?.[RAW_ENV] : undefined;
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on";
}

/**
 * Returns true only when the env var is explicitly enabled AND the caller
 * is running in paper mode. Live/mainnet always returns false.
 */
export function isDynamicUniverseEnabled(ctx: UniverseFlagContext): boolean {
  // ROLLBACK: dynamic-universe pipeline temporarily disabled — the engine
  // falls back to the legacy `repoOpenPosition` path in Phase C. Re-enable
  // by restoring the env-gated logic below once the epoch/scan/pod pipeline
  // is completed. Do NOT delete the surrounding module.
  void ctx;
  return false;
  // Original gated logic (kept for reference / re-enable):
  //   if (ctx.executionMode !== "paper") return false;
  //   return readEnvFlag();
}


/** True if the env var is set at all, regardless of mode. Diagnostics only. */
export function dynamicUniverseEnvSet(): boolean {
  return readEnvFlag();
}
