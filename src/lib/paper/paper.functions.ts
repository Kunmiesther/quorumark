/**
 * Manual paper-tick server function. SIMULATION ONLY.
 *
 * Authenticated on-demand tick for the caller ONLY (never a scheduler).
 * Uses the durable per-minute lease so a manual click cannot race the
 * server-side cron or another browser tab. Response is sanitized.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runPaperTick } from "@/lib/paper/engine";

export const runPaperTickFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try {
      const { data: claimed, error: claimErr } = await context.supabase.rpc("claim_paper_tick", {
        _user_id: context.userId,
      });
      if (claimErr) {
        return { ok: false as const, claimed: false, ranAt: Date.now() };
      }
      if (claimed !== true) {
        // Another tab / cron already handled this minute.
        return { ok: true as const, claimed: false, ranAt: Date.now() };
      }
      // All simulator accounting writes are service-only transactional RPCs.
      // Authentication still comes from the caller-bound middleware above.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await runPaperTick(supabaseAdmin, context.userId);
      return { ok: true as const, claimed: true, ranAt: Date.now() };
    } catch {
      return { ok: false as const, claimed: false, ranAt: Date.now() };
    }
  });
