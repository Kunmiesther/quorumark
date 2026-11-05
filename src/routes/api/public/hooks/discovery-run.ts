/**
 * One-shot universe-discovery endpoint. Auth via bearer PAPER_TICK_CRON_SECRET.
 * Runs `runUniverseDiscovery` for every user with enabled paper_test_symbols
 * on apex/paper/paper, regardless of tick lease. Used to seed / refresh the
 * dynamic-universe snapshot outside the per-minute tick claim.
 *
 * Never opens positions, never writes trades — only writes
 * scout_universe_snapshots + scout_symbol_rankings + scout_ranking_state
 * through the standard discovery pipeline.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";

const HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
} as const;

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}
function bearerMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  const da = digest(a);
  const db = digest(b);
  return da.length === db.length && timingSafeEqual(da, db);
}

export const Route = createFileRoute("/api/public/hooks/discovery-run")({
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

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runUniverseDiscovery } = await import("@/lib/universe/discover.functions");

        const started = Date.now();
        const { data: symUsers } = await supabaseAdmin
          .from("paper_test_symbols")
          .select("user_id")
          .eq("enabled", true);
        const userIds = Array.from(new Set((symUsers ?? []).map((r) => r.user_id as string)));

        const results: Array<{ userId: string; eligible: number; ranked: number; snapshotId: string } | { userId: string; error: string }> = [];
        for (const userId of userIds) {
          try {
            const snap = await runUniverseDiscovery(supabaseAdmin, userId, {
              exchange: "apex",
              environment: "paper",
              marketType: "paper",
            });
            results.push({
              userId,
              eligible: snap.eligibleCount,
              ranked: snap.rankedCount,
              snapshotId: snap.correlationId,
            });
          } catch (e) {
            results.push({ userId, error: (e as Error).message.slice(0, 200) });
          }
        }

        return new Response(
          JSON.stringify({
            ok: true,
            processed: userIds.length,
            durationMs: Date.now() - started,
            results,
          }),
          { headers: HEADERS },
        );
      },
    },
  },
});
