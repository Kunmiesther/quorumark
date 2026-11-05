/**
 * Best-effort telemetry writers for the paper engine (Phase 4C extraction).
 *
 * SEMANTICS: every write here is EXPLICITLY best-effort — a failed insert
 * MUST NOT bubble into the tick's control flow. All catches are intentional
 * per the docs/PAPER_ENGINE_ARCHITECTURE.md typed failure model: telemetry
 * is the only stage allowed to swallow errors silently.
 */
import { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { Json } from "@/integrations/supabase/types";

/** Best-effort `bot_events` insert. Returns true on success, false on error. */
export async function emitBotEvent(
  supabase: SupabaseClient<Database>,
  userId: string,
  event: string,
  detail: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
): Promise<boolean> {
  try {
    const { error } = await supabase.from("bot_events").insert({
      user_id: userId,
      event,
      level,
      detail: detail as unknown as Json,
    });
    return !error;
  } catch {
    return false;
  }
}
