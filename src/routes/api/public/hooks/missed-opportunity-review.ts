/** Cron-only, market-data-only feedback review. Never imports execution code. */
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize.server";

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

const handleReview = async ({ request }: { request: Request }) => {
  if (!isAuthorizedCronRequest(request, [process.env.CRON_SECRET])) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: HEADERS });
  }
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { reviewMissedOpportunities } = await import("@/lib/ai/committee/opportunityReview.server");
    const result = await reviewMissedOpportunities(supabaseAdmin);
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: HEADERS });
  } catch (error) {
    console.error("missed opportunity review failed", error);
    return new Response(JSON.stringify({ ok: false, error: "review_failed" }), {
      status: 500,
      headers: HEADERS,
    });
  }
};

export const Route = createFileRoute("/api/public/hooks/missed-opportunity-review")({
  server: { handlers: { GET: handleReview, POST: handleReview } },
});
