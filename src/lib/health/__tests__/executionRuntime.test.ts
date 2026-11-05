import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("src/lib/health/executionRuntime.functions.ts", "utf8");

describe("execution runtime truth contract", () => {
  it("checks broker, signer, and the automation endpoint independently", () => {
    expect(source).toContain("/healthz");
    expect(source).toContain("/readyz");
    expect(source).toContain("/v1/automation/capabilities");
  });

  it("does not infer automated execution from feature flags alone", () => {
    expect(source).toMatch(/flags\.automation\s*&&\s*automationEndpoint/);
    expect(source).toContain("supported_campaign_rung_counts.includes(5)");
    expect(source).toContain("five-rung automated execution is not supported yet");
  });

  it("never exposes the configured broker URL in its response", () => {
    expect(source).not.toMatch(/return\s*\{[^}]*\bbase\b/s);
    expect(source).not.toMatch(/brokerUrl\s*:/);
  });
});
