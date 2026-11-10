import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import { decodeNearNonce, toNearWalletNonce } from "./near-nonce";

describe("NEP-413 nonce conversion", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const base64 = Buffer.from(bytes).toString("base64");

  it("round-trips a server-issued 32-byte hex nonce", () => {
    expect(decodeNearNonce(hex)).toEqual(bytes);
    const nonce = toNearWalletNonce(hex);
    expect(Buffer.isBuffer(nonce)).toBe(true);
    expect(nonce.length).toBe(32);
  });

  it("decodes a server-issued base64 nonce to the same bytes", () => {
    expect(decodeNearNonce(base64)).toEqual(bytes);
  });

  it.each(["", "00", "not-base64!", base64.slice(0, -4)])("rejects nonce %j", (value) => {
    expect(() => decodeNearNonce(value)).toThrow(/32 bytes|decoded|base64/);
  });
});
