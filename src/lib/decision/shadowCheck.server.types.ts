/**
 * Client-safe constants and types for the shadow AI connectivity check.
 * Split from `shadowCheck.server.ts` so route/UI modules can import the
 * result shape without pulling the provider layer into the client bundle.
 */
import type { ProviderOutcome } from "@/lib/ai/committee/schema";

export const TEST_CANDIDATE_PREFIX = "diag_shadow_";
export const SHADOW_CHECK_EVENT = "SHADOW_AI_CHECK";
export const SHADOW_CHECK_COOLDOWN_MS = 60_000;

export interface ShadowCheckResult {
  ranAt: string;
  testCandidateId: string;
  /** Constant marker the UI renders as the TEST / NON-TRADING badge. */
  diagnostic: true;
  schemaVersion: string;
  promptVersion: string;
  totalLatencyMs: number;
  outcomes: ProviderOutcome[];
}
