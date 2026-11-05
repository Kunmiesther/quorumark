import { describe, it, expect } from "vitest";
import { signApexOmni } from "./apex-omni-sign";

// Known-answer vector produced with the reference algorithm:
//   Node:
//     key   = base64('test-secret-abcdefghijklmnop')
//     msg   = '1700000000000' + 'GET' + '/api/v3/account-balance' + ''
//     sig   = base64( HMAC_SHA256(key, msg) )
// matching ApeX-Protocol/apexomni-connector-node PrivateApi.sign().
describe("signApexOmni", () => {
  it("matches the SDK base-string + base64(base64(secret)) HMAC scheme", async () => {
    const sig = await signApexOmni({
      method: "GET",
      requestPath: "/api/v3/account-balance",
      timestampMs: 1700000000000,
      params: "",
      secret: "test-secret-abcdefghijklmnop",
    });
    expect(sig).toBe("nImrH1vhnPsRLU4jGtQPlyOw2DPxZruFgO6lbm3AOGk=");
  });

  it("is deterministic across calls", async () => {
    const a = await signApexOmni({
      method: "GET",
      requestPath: "/api/v3/user",
      timestampMs: 1,
      params: "",
      secret: "s",
    });
    const b = await signApexOmni({
      method: "GET",
      requestPath: "/api/v3/user",
      timestampMs: 1,
      params: "",
      secret: "s",
    });
    expect(a).toBe(b);
  });
});
