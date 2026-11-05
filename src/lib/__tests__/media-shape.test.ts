import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("shared image shape contract", () => {
  it("gives all images rounded defaults while preserving explicit circular identity marks", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/img\s*\{\s*border-radius: var\(--tb-media-radius, 0\.75rem\)/);
    const identities = readFileSync("src/components/exchanges/ConnectionIdentity.tsx", "utf8");
    expect(identities.match(/rounded-full object-contain/g)).toHaveLength(2);
  });
});
