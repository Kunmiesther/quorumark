/**
 * PAPER_ENGINE_ENABLED — global, reversible paper-trading kill switch.
 *
 * Purpose: allow paper trading to be turned OFF and back ON instantly.
 * Nothing else. It does NOT touch the live pipeline, does NOT delete or
 * mutate any historical paper data, and does NOT change any setting.
 *
 * Toggle: set the server env var `PAPER_ENGINE_ENABLED`
 *   - unset (default) or "1" / "true" / "on"  → paper engine RUNS
 *   - "0" / "false" / "off"                   → paper engine is OFF
 *
 * When OFF, `runPaperTick` returns immediately at the top of the loop:
 * no market scan, no intents, no positions, no trades.
 */

const ENV_KEY = "PAPER_ENGINE_ENABLED";

export function isPaperEngineEnabled(): boolean {
  const raw =
    typeof process !== "undefined" ? process.env?.[ENV_KEY] : undefined;
  if (raw == null || raw === "") return true; // default ON — reversible, non-breaking
  const v = String(raw).trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

/** Raw env value, diagnostics/UI only. */
export function paperEngineFlagRaw(): string | null {
  const raw =
    typeof process !== "undefined" ? process.env?.[ENV_KEY] : undefined;
  return raw == null || raw === "" ? null : String(raw);
}
