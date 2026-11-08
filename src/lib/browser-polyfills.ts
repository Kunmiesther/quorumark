// Keep the browser-compatible Buffer implementation available before any
// NEAR wallet module can call its cryptography helpers. This is intentionally
// limited to Buffer; Quorumark does not polyfill the Node runtime wholesale.
export async function ensureBrowserPolyfills(): Promise<void> {
  if (typeof window === "undefined") return;
  const runtime = globalThis as typeof globalThis & { Buffer?: unknown };
  if (runtime.Buffer) return;
  const { Buffer } = await import("buffer");
  runtime.Buffer = Buffer;
}
