import { describe, expect, it } from "vitest";
import { redactObject, maskSecret, isSensitiveKey } from "../redact";

describe("bydfi/redact", () => {
  it("fully masks short strings and previews long ones", () => {
    expect(maskSecret("short")).toBe("••••••");
    expect(maskSecret("abcd1234efgh5678")).toBe("abcd…5678");
  });

  it("classifies sensitive keys", () => {
    for (const k of ["api_key", "apiKey", "API_SECRET", "passphrase", "X-API-SIGNATURE", "authorization", "omni_seed", "token"]) {
      expect(isSensitiveKey(k)).toBe(true);
    }
    for (const k of ["symbol", "verified_at", "exchange", "user_id"]) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });

  it("recursively redacts credential-shaped fields in nested payloads", () => {
    const src = {
      exchange: "bydfi",
      creds: {
        api_key: "ak_super_long_and_secret_key_value_12345",
        api_secret: "sk_super_long_and_secret_key_value_67890",
        passphrase: "hunter2hunter2hunter2",
      },
      headers: {
        "X-API-KEY": "ak_super_long_and_secret_key_value_12345",
        "X-API-SIGNATURE": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      },
      nested: [{ token: "tokenvalue_super_long_1234" }, { symbol: "BTC-USDT" }],
    };
    const out = redactObject(src);
    expect(out.exchange).toBe("bydfi");
    expect(out.creds.api_key).not.toContain("super_long");
    expect(out.creds.api_secret).not.toContain("super_long");
    expect(out.creds.passphrase).toBe("hunt…ter2");
    expect(out.headers["X-API-KEY"]).not.toContain("super_long");
    expect(out.headers["X-API-SIGNATURE"]).not.toContain("abcdef0123456789abcdef");
    expect(out.nested[0].token).not.toContain("super_long");
    expect(out.nested[1].symbol).toBe("BTC-USDT");
  });

  it("never returns the original secret value verbatim in redacted output", () => {
    const secret = "sk_never_show_this_full_secret_00000000000000000000";
    const out = JSON.stringify(redactObject({ api_secret: secret, log: { secret } }));
    expect(out).not.toContain(secret);
  });
});
