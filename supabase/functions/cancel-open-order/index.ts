// Owner-scoped cancellation of ONE resting ApeX order by client order id.
//
// WHY: a stale unfilled entry rung keeps resting at the venue with no
// position attached. It is invisible to every position surface, yet the
// signer's preflight refuses any new entry on that symbol with
// EXISTING_OPEN_ORDER — so one orphan silently blocks a whole symbol.
//
// AUTHORITY: cancel only. This function cannot place, size, modify or close
// anything. It forwards a single `/v1/cancel-order` call to the signer, which
// re-checks its own flags (SIGNER_ENABLED, CANCEL_ORDER) before touching the
// venue. The caller must be signed in AND own the exchange connection.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { apexCancelOrder, loadApexReadCreds } from "../_shared/apex-omni-read.ts";
import {
  isQuorumarkMvpMode,
  quorumarkMvpDisabledResponse,
} from "../_shared/quorumark-mvp-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(500, { error: "SUPABASE_NOT_CONFIGURED" });

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "UNAUTHENTICATED" });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: userRes, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userRes?.user) return json(401, { error: "UNAUTHENTICATED" });
  const userId = userRes.user.id;
  if (isQuorumarkMvpMode()) return quorumarkMvpDisabledResponse("cancel-open-order", corsHeaders);

  let body: { connection_id?: string; client_order_id?: string; order_id?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "BAD_REQUEST" });
  }
  const connectionId = String(body.connection_id ?? "");
  const clientOrderId = body.client_order_id ? String(body.client_order_id) : null;
  const orderId = body.order_id ? String(body.order_id) : null;
  if (!connectionId || (!clientOrderId && !orderId)) return json(400, { error: "MISSING_FIELDS" });

  // Ownership is proven against the ledger, never inferred from the request.
  const { data: conn } = await admin
    .from("exchange_connections")
    .select("id, user_id, environment")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!conn) return json(403, { error: "NOT_CONNECTION_OWNER" });

  // Cancel in-process. The signer's /v1/cancel-order rejects ApeX's current
  // reply shape with BAD_RESPONSE_JSON, so routing recovery through it would
  // leave an orphan resting forever. Read-path credentials, cancel-only write.
  const credsRes = await loadApexReadCreds(
    admin as never,
    connectionId,
    String((conn as { environment?: string }).environment ?? "mainnet"),
  );
  if (!credsRes.ok) return json(200, { ok: false, reason: credsRes.reason });

  const result = await apexCancelOrder(credsRes.creds, { orderId, clientOrderId });
  return json(200, {
    ok: result.ok,
    http_status: result.status,
    reason: result.reason ?? null,
    venue_response: result.data ?? null,
  });
});
