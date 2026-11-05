/** Temporary protected-preview ARC replay transport. Advisory only. */
import { createFileRoute } from "@tanstack/react-router";
import type { MarketSnapshot } from "@/lib/ai/committee/schema";

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

export const Route = createFileRoute("/api/public/hooks/arc-shadow-review")({
  server: { handlers: { POST: async ({ request }) => {
    const length = Number(request.headers.get("content-length") || "0");
    if (length > 128_000) return new Response(JSON.stringify({ ok: false }), { status: 413, headers: HEADERS });
    let snapshot: MarketSnapshot;
    try { snapshot = await request.json() as MarketSnapshot; }
    catch { return new Response(JSON.stringify({ ok: false }), { status: 400, headers: HEADERS }); }
    if (!snapshot?.candidate_id?.startsWith("ARC-") || !["BTC-USDT", "ETH-USDT", "SOL-USDT"].includes(snapshot.symbol)) {
      return new Response(JSON.stringify({ ok: false }), { status: 400, headers: HEADERS });
    }
    const { reviewArcSnapshot } = await import("@/lib/ai/arc/replay.server");
    const result = await reviewArcSnapshot(snapshot);
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: HEADERS });
  } } },
});
