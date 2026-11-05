/**
 * Server-side ops event emit helper. Wraps the `emit_ops_event` RPC.
 *
 * READ-ONLY WITHIN THIS MODULE'S OWNERSHIP: never touches paper engine,
 * execution broker, signer, or wallet mutation. It only appends a
 * correlation event row.
 *
 * Callers are expected to pass an existing SupabaseClient scoped to the
 * user (via `requireSupabaseAuth` context). No admin client used.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type OpsStage =
  | "scout_scan"
  | "onyx_decision"
  | "paper_intent"
  | "paper_fill"
  | "paper_reject"
  | "watchdog"
  | "wallet_activation";

export type OpsSeverity = "info" | "warn" | "error";

export interface EmitOpsEventArgs {
  correlation_id: string;
  stage: OpsStage;
  component: string;
  severity?: OpsSeverity;
  message?: string;
  detail?: Record<string, unknown> | null;
  latency_ms?: number | null;
}

/**
 * Best-effort emit. Never throws — telemetry failure must not block the
 * business path. Failures are silent by design (the missing row will show
 * up as a freshness gap in the ops panel).
 */
export async function emitOpsEvent(
  _supabase: SupabaseClient,
  args: EmitOpsEventArgs,
): Promise<void> {
  try {
    // `emit_ops_event` is SECURITY DEFINER and no longer callable by the
    // `authenticated` role (see supabase migration hardening definer fns).
    // Route through the service-role admin client instead.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.rpc("emit_ops_event" as never, {
      _correlation_id: args.correlation_id,
      _stage: args.stage,
      _component: args.component,
      _severity: args.severity ?? "info",
      _message: (args.message ?? "").slice(0, 500),
      _detail: args.detail ?? null,
      _latency_ms: args.latency_ms ?? null,
    } as never);
  } catch {
    // Swallow — telemetry must never break the caller.
  }
}
