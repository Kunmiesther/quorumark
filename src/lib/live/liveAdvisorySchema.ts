/**
 * LIVE POSITION ADVISORY — versioned, provider-neutral response contract.
 *
 * ADVISORY ONLY. Nothing produced through this contract may submit, cancel,
 * resize or close an order. There is deliberately no order id, no quantity,
 * no credential and no venue handle in this schema. The consumer persists
 * the answer and renders it; it never routes it to the signer or broker.
 */
import { z } from "zod";

export const LIVE_ADVISORY_SCHEMA_VERSION = "live_advisory.v1";

/** Ordered from least to most defensive. Used for conservative consensus. */
export const LIVE_ACTIONS = [
  "no_change",
  "hold",
  "hedge",
  "reduce",
  "bank_profit",
  "exit",
] as const;
export type LiveAdvisoryAction = (typeof LIVE_ACTIONS)[number];

/** Higher = more defensive. `exit` always wins a disagreement. */
export const ACTION_SEVERITY: Record<LiveAdvisoryAction, number> = {
  no_change: 0,
  hold: 1,
  hedge: 2,
  reduce: 3,
  bank_profit: 4,
  exit: 5,
};

export const liveAdvisoryResponseSchema = z.object({
  schema_version: z.literal(LIVE_ADVISORY_SCHEMA_VERSION),
  action: z.enum(LIVE_ACTIONS),
  confidence: z.number().min(0).max(1),
  /** Fraction of the position the seat would reduce, 0..1. Null when N/A. */
  reduce_fraction: z.number().min(0).max(1).nullable(),
  /** Price that would invalidate the current thesis. Null when N/A. */
  invalidation: z.number().nullable(),
  risk_flags: z.array(z.string()).max(12),
  rationale: z.string().max(600),
});
export type LiveAdvisoryResponse = z.infer<typeof liveAdvisoryResponseSchema>;

export type LiveUnavailableReason =
  | "missing_credential"
  | "timeout"
  | "http_error"
  | "malformed_json"
  | "schema_invalid"
  | "empty_response"
  | "stale_snapshot"
  | "invalid_model_config";

export type LiveSeatOutcome =
  | {
      role: string;
      provider: string;
      model: string;
      latencyMs: number;
      available: true;
      response: LiveAdvisoryResponse;
    }
  | {
      role: string;
      provider: string;
      model: string;
      latencyMs: number;
      available: false;
      reason: LiveUnavailableReason;
      detail: string;
    };

/** Strip markdown fences a model may wrap JSON in. Never throws. */
function stripFences(text: string): string {
  const t = text.trim();
  if (!t.startsWith("```")) return t;
  return t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
}

export function parseLiveAdvisoryResponse(
  text: string | null,
):
  | { ok: true; value: LiveAdvisoryResponse }
  | { ok: false; reason: LiveUnavailableReason; detail: string } {
  if (!text || !text.trim()) return { ok: false, reason: "empty_response", detail: "no text" };
  let json: unknown;
  try {
    json = JSON.parse(stripFences(text));
  } catch {
    return { ok: false, reason: "malformed_json", detail: "response was not valid JSON" };
  }
  const parsed = liveAdvisoryResponseSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_invalid",
      detail: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
        .slice(0, 200),
    };
  }
  return { ok: true, value: parsed.data };
}
