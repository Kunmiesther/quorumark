import { describe, expect, it } from "vitest";
import { parseOnyxModelResponse } from "./modelResponse";

const payload = {
  decisions: [{ action: "hold", symbol: "ETH-USDT", rationale: "Wait for confirmation." }],
  narrative: "No deployment yet.",
};

describe("parseOnyxModelResponse", () => {
  it("parses a plain JSON string", () => {
    expect(parseOnyxModelResponse(JSON.stringify(payload))).toEqual(payload);
  });

  it("parses fenced JSON after a reasoning block", () => {
    const content = `<think>private reasoning</think>\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    expect(parseOnyxModelResponse(content)).toEqual(payload);
  });

  it("parses OpenAI-style content-part arrays", () => {
    expect(parseOnyxModelResponse([{ type: "text", text: JSON.stringify(payload) }])).toEqual(
      payload,
    );
  });

  it("does not accept prose without a JSON object", () => {
    expect(parseOnyxModelResponse("I would hold ETH for now.")).toBeNull();
  });
});
