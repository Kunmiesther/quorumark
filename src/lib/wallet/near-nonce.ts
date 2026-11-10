import { Buffer as NodeBuffer } from "buffer";

/** Decode the server-issued NEP-413 nonce without generating or normalizing it. */
export function decodeNearNonce(value: string): Uint8Array {
  const input = value.trim();
  let bytes: Uint8Array;

  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    bytes = Uint8Array.from({ length: 32 }, (_, index) =>
      Number.parseInt(input.slice(index * 2, index * 2 + 2), 16),
    );
  } else {
    // Supabase may expose the opaque nonce as base64. atob is available in
    // browsers and Deno; the URL-safe variant is accepted for transport too.
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
      throw new Error("NEAR authentication nonce is not valid base64.");
    }
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    try {
      bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    } catch {
      throw new Error("NEAR authentication nonce could not be decoded.");
    }
  }

  if (bytes.length !== 32) {
    throw new Error("NEAR authentication nonce must be exactly 32 bytes.");
  }
  return bytes;
}

/** Wallet Selector's public contract is specifically a Node-compatible Buffer. */
export function toNearWalletNonce(value: string): NodeBuffer {
  // Wallet Selector 10.1.4 validates with its runtime Buffer.isBuffer check.
  // The app installs this same constructor globally before loading Selector.
  const nonce = NodeBuffer.from(decodeNearNonce(value));
  if (!NodeBuffer.isBuffer(nonce) || nonce.length !== 32) {
    throw new Error("NEAR authentication nonce must be a 32-byte Buffer.");
  }
  return nonce;
}
