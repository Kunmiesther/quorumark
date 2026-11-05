/**
 * Owner-scoped override precedence resolver.
 *
 * Deterministic rule (encoded here, NOT in SQL):
 *   emergency_allow  →  force_include (bypasses eligibility)
 *   deny             →  force_exclude
 *   allow            →  no-op (a symbol still has to pass eligibility)
 *
 * Expired rows are ignored. When multiple rows for the same symbol are
 * present, the highest-precedence non-expired kind wins.
 */
import type { OverrideKind, ResolvedOverride, UniverseOverride } from "./types";

const PRECEDENCE: Record<OverrideKind, number> = {
  emergency_allow: 3,
  deny: 2,
  allow: 1,
};

export function resolveOverrides(
  raw: UniverseOverride[],
  now = Date.now(),
): ResolvedOverride[] {
  const bySymbol = new Map<string, UniverseOverride>();
  for (const o of raw) {
    if (o.expiresAt != null && o.expiresAt <= now) continue;
    const cur = bySymbol.get(o.symbol);
    if (!cur || PRECEDENCE[o.kind] > PRECEDENCE[cur.kind]) {
      bySymbol.set(o.symbol, o);
    }
  }
  const out: ResolvedOverride[] = [];
  for (const [symbol, o] of bySymbol) {
    let effective: ResolvedOverride["effective"];
    if (o.kind === "emergency_allow") effective = "force_include";
    else if (o.kind === "deny") effective = "force_exclude";
    else effective = "none";
    out.push({ symbol, effective, source: o.kind });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}
