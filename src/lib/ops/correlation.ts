/**
 * Correlation-ID helpers. A single ID follows a signal from Scout scan
 * → Onyx decision → paper intent → fill/outcome. Every ops_event and
 * onyx_decisions row for the same lifecycle shares the ID.
 *
 * Pure — no side effects. Uses crypto.randomUUID which is available in
 * both the browser and the server Worker runtime.
 */
export type CorrelationId = string;

export function newCorrelationId(): CorrelationId {
  // Prefer the Web Crypto API; fall back only for very old runtimes.
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return g.randomUUID();
  // RFC4122-ish fallback; never used in Worker or modern browser.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function isCorrelationId(v: unknown): v is CorrelationId {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
