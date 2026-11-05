import { describe, expect, it } from "vitest";
import { isAuthorizedServiceReader } from "../../../supabase/functions/_shared/service-reader-auth";

const legacy = "test-legacy-service-token";
const secret = "sb_secret_test-only-not-a-real-key";
const keys = JSON.stringify({ reader: secret });
const request = (headers: Record<string, string> = {}) => new Request("https://example.test", { headers });

describe("service reader authentication", () => {
  it("accepts the exact legacy service-role bearer", () => {
    expect(isAuthorizedServiceReader(request({ authorization: `Bearer ${legacy}` }), legacy, undefined)).toBe(true);
  });
  it("accepts an exact configured secret API key with a rotated legacy bearer", () => {
    expect(isAuthorizedServiceReader(request({ apikey: secret, authorization: "Bearer another-valid-legacy-token" }), legacy, keys)).toBe(true);
  });
  it("accepts a named key during overlapping rotation", () => {
    expect(isAuthorizedServiceReader(request({ apikey: secret }), legacy, JSON.stringify({ old: "sb_secret_old", current: secret }))).toBe(true);
  });
  it.each<Record<string, string>>([
    {}, { authorization: "Bearer user-token" }, { authorization: "Bearer " },
    { apikey: "sb_publishable_test" }, { apikey: "sb_secret_wrong" },
    { apikey: `${secret}x` }, { apikey: legacy }, { authorization: `Basic ${legacy}` },
    { authorization: `Bearer ${secret}` },
  ])("rejects unauthorized headers %j", headers => {
    expect(isAuthorizedServiceReader(request(headers), legacy, keys)).toBe(false);
  });
  it.each([undefined, "", "invalid", "null", "[]", '"a string"', '{"key":123}'])
    ("fails closed with invalid configuration %s", config => {
      expect(isAuthorizedServiceReader(request({ apikey: secret }), undefined, config)).toBe(false);
    });
  it("does not accept configured publishable keys", () => {
    expect(isAuthorizedServiceReader(request({ apikey: "sb_publishable_test" }), undefined, '{"key":"sb_publishable_test"}')).toBe(false);
  });
});
