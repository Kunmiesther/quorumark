/**
 * BILLS SURPLUS SCAN CRON HOOK — detects + notifies Life Map reallocation
 * suggestions for every user with active bills.
 *
 * The Telegram webhook already piggybacks this same detection on any
 * linked-user interaction, so this hook only matters for users who neither
 * have the app open (which polls getLifeMapSnapshot → detection) nor
 * message the bot for a while. Needs the same external scheduling as
 * paper-tick / committee-cycle / ai-advisory — nothing in this repo calls
 * these hooks on its own; wire it to whatever already triggers those.
 *
 * ZERO EXECUTION AUTHORITY beyond bill_allocations/bill_reallocation_suggestions
 * rows and an outbound Telegram message — no signer, broker, or order path.
 *
 * Auth: `Authorization: Bearer <PAPER_TICK_CRON_SECRET>` (timing-safe) —
 * reuses the same secret as the other paper-side hooks rather than minting
 * a new one.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const MAX_USERS_PER_RUN = 200;

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}
function bearerMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  const da = digest(a);
  const db = digest(b);
  return da.length === db.length && timingSafeEqual(da, db);
}

export const Route = createFileRoute("/api/public/hooks/bills-surplus-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.PAPER_TICK_CRON_SECRET ?? "";
        const header = request.headers.get("authorization") ?? "";
        if (!expected || !header.toLowerCase().startsWith("bearer ")) {
          return new Response(JSON.stringify({ ok: false }), { status: 401, headers: HEADERS });
        }
        if (!bearerMatches(header.slice(7).trim(), expected)) {
          return new Response(JSON.stringify({ ok: false }), { status: 401, headers: HEADERS });
        }

        const started = Date.now();
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { detectReallocationSuggestions } = await import("@/lib/bills/reallocation.functions");

        const { data: rows, error } = await supabaseAdmin
          .from("bills")
          .select("user_id")
          .is("archived_at", null)
          .limit(5000);
        if (error) {
          return new Response(JSON.stringify({ ok: false, stage: "read" }), { status: 200, headers: HEADERS });
        }
        const userIds = Array.from(new Set((rows ?? []).map((r) => r.user_id as string))).slice(
          0,
          MAX_USERS_PER_RUN,
        );

        let suggested = 0;
        let errored = 0;
        for (const userId of userIds) {
          try {
            const found = await detectReallocationSuggestions(supabaseAdmin, userId);
            suggested += found.length;
          } catch {
            errored += 1;
          }
        }

        return new Response(
          JSON.stringify({
            ok: true,
            users_scanned: userIds.length,
            pending_suggestions: suggested,
            errored,
            duration_ms: Date.now() - started,
          }),
          { headers: HEADERS },
        );
      },
    },
  },
});
