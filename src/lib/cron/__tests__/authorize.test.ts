import { describe, expect, it } from "vitest";
import { isAuthorizedCronRequest } from "../authorize.server";

function request(token?: string) {
  return new Request("https://www.turtlebot.app/api/public/hooks/runtime", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("cron request authorization", () => {
  it("accepts Vercel CRON_SECRET when a dedicated secret is also configured", () => {
    expect(
      isAuthorizedCronRequest(request("vercel-secret"), ["manual-secret", "vercel-secret"]),
    ).toBe(true);
  });

  it("accepts the dedicated operator secret", () => {
    expect(
      isAuthorizedCronRequest(request("manual-secret"), ["manual-secret", "vercel-secret"]),
    ).toBe(true);
  });

  it("fails closed for missing, empty, malformed, or wrong credentials", () => {
    expect(isAuthorizedCronRequest(request(), ["vercel-secret"])).toBe(false);
    expect(isAuthorizedCronRequest(request("wrong"), ["vercel-secret"])).toBe(false);
    expect(isAuthorizedCronRequest(request("anything"), [undefined, "  "])).toBe(false);
    expect(
      isAuthorizedCronRequest(
        new Request("https://www.turtlebot.app", { headers: { authorization: "Basic nope" } }),
        ["vercel-secret"],
      ),
    ).toBe(false);
  });
});
