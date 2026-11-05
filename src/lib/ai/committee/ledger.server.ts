// SERVER-ONLY ledger adapter for the shadow committee.
//
// The single privileged capability the committee owns: a service-role write
// to `ai_committee_evaluations`. Keeping it behind this one-function module
// means the server-function layer never imports an admin client directly,
// and any future privileged use has exactly one place to be reviewed.

import type { SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Service-role client, used ONLY to append advisory evaluation records.
 * Never returned to the caller as a general-purpose client path.
 */
export async function ledgerClient(): Promise<SupabaseClient> {
  if (!cached) {
    const mod = await import("@/integrations/supabase/client.server");
    cached = mod.supabaseAdmin as unknown as SupabaseClient;
  }
  return cached;
}
