import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import {
  deriveWorkerHealth,
  PRODUCTION_LIVE_SELECTOR,
  WORKER_HEARTBEAT_COLUMNS,
  type WorkerHeartbeatRow,
} from "@/lib/health/workerHealth";


function sb(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "get_bot_status",
  title: "Get bot status",
  description: "Get the current Turtle bot status, active strategy, and wallet balance for the signed-in user.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = sb(ctx);
    const userId = ctx.getUserId();

    const [profile, strategy, heartbeats] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
      supabase.from("user_strategy").select("*").eq("user_id", userId).order("symbol", { ascending: true })
          .limit(1).maybeSingle(),
      // Authoritative: worker_heartbeats (production/live). Legacy bot_heartbeat is not read.
      supabase
        .from("worker_heartbeats")
        .select(WORKER_HEARTBEAT_COLUMNS)
        .eq("environment", PRODUCTION_LIVE_SELECTOR.environment)
        .order("last_seen_at", { ascending: false })
        .limit(50),
    ]);

    const health = deriveWorkerHealth(
      (heartbeats.data ?? []) as WorkerHeartbeatRow[],
      Date.now(),
    );

    const payload = {
      profile: profile.data,
      strategy: strategy.data,
      worker_health: health,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
});
