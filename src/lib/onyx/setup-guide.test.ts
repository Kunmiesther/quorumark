import { describe, expect, it } from "vitest";
import { isMarketSetupQuestion } from "./setup-guide.functions";

describe("isMarketSetupQuestion", () => {
  it.each([
    "What is the best available setup right now?",
    "Find me a trade",
    "Show me the strongest opportunity",
    "What should I trade?",
  ])("recognizes a market-scan request: %s", (question) => {
    expect(isMarketSetupQuestion(question)).toBe(true);
  });

  it.each(["What do I need before I can trade?", "Explain my setup", "How does Autopilot work?"])(
    "does not swallow a setup-guide request: %s",
    (question) => {
      expect(isMarketSetupQuestion(question)).toBe(false);
    },
  );
});
