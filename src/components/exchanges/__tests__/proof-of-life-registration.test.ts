import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(
  resolve(process.cwd(), "src/components/exchanges/ProofOfLifeButton.tsx"),
  "utf8",
);

describe("ApeX account registration UI refresh", () => {
  it("refreshes every live-routing status consumer after registration", () => {
    for (const queryKey of [
      "exchange-connections-full",
      "execution-status",
      "trust-center-feed",
      "mainnet-accumulator-connection",
    ]) {
      expect(SOURCE).toContain(`qc.invalidateQueries({ queryKey: ["${queryKey}"] })`);
    }
  });
});
