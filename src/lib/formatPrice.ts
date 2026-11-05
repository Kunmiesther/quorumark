/**
 * Magnitude-aware price formatter.
 *
 * Ruling #9 DEFECT 2: a fixed 2-decimal formatter destroys sub-dollar
 * assets (ADA 0.1546 rendered "0.16"; DOGE 0.0698 rendered "0.07").
 * The rule is: format by magnitude, never by a fixed decimal count.
 *   - |v| >= 1000  → thousands-separated, 2 decimals (e.g. 63,453.60)
 *   - |v| >= 1     → 4 decimals
 *   - |v| <  1     → 5 decimals (owner example: 0.15460, 0.06980)
 * Returns "—" for null / non-finite input. Never fabricates a value.
 */
export function formatPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1000) {
    return v.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (abs >= 1) {
    return v.toLocaleString(undefined, {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
  }
  return v.toLocaleString(undefined, {
    minimumFractionDigits: 5,
    maximumFractionDigits: 5,
  });
}

/** Size formatter — trims trailing zeros but caps precision by magnitude. */
export function formatSize(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 3 : 5;
  return v.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}
