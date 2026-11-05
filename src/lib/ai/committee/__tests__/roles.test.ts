// Guard: vendor/model branding AND internal seat role names must never render
// on client-facing intelligence surfaces. Provider/model/role provenance stays
// in the database, logs, audit exports and owner "Technical details" only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AI_LABEL,
  ONYX_IDENTITY,
  aiCollectiveState,
  aiStateLabel,
  participationLabel,
  roleName,
} from "../roles";

const CLIENT_FILES = [
  "src/components/trade/CommitteePanel.tsx",
  "src/components/trade/CommitteeCalibrationPanel.tsx",
  "src/components/candidate/CandidateOnyxExplanation.tsx",
  "src/components/scout/LiveDecisionFlowPanel.tsx",
  "src/routes/_authenticated/decisions.tsx",
  "src/routes/_authenticated/agentic.tsx",
];

// Vendor/model provenance only. Seat role NAMES are intentionally customer
// facing (owner correction 2026-08-03).
const FORBIDDEN = /\b(OpenAI|Anthropic|Claude|Gemini|gpt-\d|claude-|gemini-)\b/;

describe("customer-facing AI naming", () => {
  it("names the three customer-facing seats and ONYX", () => {
    expect(AI_LABEL).toBe("AI");
    expect(roleName("lead")).toBe("Lead Strategist");
    expect(roleName("risk")).toBe("Risk Guardian");
    expect(roleName("structure")).toBe("Market Structure Analyst");
    expect(ONYX_IDENTITY.name).toBe("ONYX");
    expect(ONYX_IDENTITY.decision).toBe("ONYX DECISION");
  });

  it("uses simple states and never claims unavailable when opinions exist", () => {
    expect(aiStateLabel(aiCollectiveState({ asked: 3, available: 3 }))).toBe("AI ACTIVE");
    expect(aiStateLabel(aiCollectiveState({ asked: 3, available: 2 }))).toBe("AI DEGRADED");
    expect(aiStateLabel(aiCollectiveState({ asked: 3, available: 1 }))).toBe("AI DEGRADED");
    expect(aiStateLabel(aiCollectiveState({ asked: 3, available: 0 }))).toBe("AI UNAVAILABLE");
    expect(aiStateLabel(aiCollectiveState({ asked: 0, available: 0, pending: true }))).toBe(
      "AI REVIEWING",
    );
  });

  it("reports participation", () => {
    expect(participationLabel(3, 3)).toBe("3/3 reviewed");
    expect(participationLabel(2, 3)).toBe("2/3 reviewed");
  });

  it.each(CLIENT_FILES)("%s contains no vendor or model branding", (file) => {
    const src = readFileSync(file, "utf8");
    const offending = src
      .split("\n")
      .filter(
        (l) =>
          FORBIDDEN.test(l) && !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"),
      );
    expect(offending).toEqual([]);
  });
});
