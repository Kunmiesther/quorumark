/**
 * Server-only AES-256-GCM encryption for BYDFi credentials.
 *
 * Envelope format (base64):
 *   [ 12B IV ][ ciphertext + 16B GCM tag ]
 *
 * Uses BYDFI_CREDENTIALS_ENCRYPTION_KEY (base64 or hex 32 bytes). Reads env
 * inside the call — never at module scope — so build-time client bundles
 * never see the value even by accident. Not exported to the browser.
 */

const KEY_ENV = "BYDFI_CREDENTIALS_ENCRYPTION_KEY";

function decodeKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  // Try base64 first
  try {
    const bytes = Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
    if (bytes.length === 32) return bytes;
  } catch { /* fallthrough */ }
  // Try hex
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === 64) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  throw new Error("BYDFI encryption key must be 32 raw bytes (base64 or hex).");
}

async function importKey(): Promise<CryptoKey> {
  const raw = process.env[KEY_ENV];
  if (!raw) throw new Error(`${KEY_ENV} is not configured.`);
  const raw32 = decodeKey(raw);
  // Copy into a fresh ArrayBuffer so the WebCrypto typings accept it in
  // strict mode (BufferSource requires ArrayBuffer, not ArrayBufferLike).
  const ab = new ArrayBuffer(raw32.length);
  new Uint8Array(ab).set(raw32);
  return crypto.subtle.importKey("raw", ab, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) throw new Error("Cannot encrypt empty value.");
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return toB64(out);
}

export async function decryptSecret(envelope: string): Promise<string> {
  const key = await importKey();
  const buf = fromB64(envelope);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
