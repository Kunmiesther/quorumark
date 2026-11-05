// Post-verification wallet management. Authenticated actions only.
// All state changes go through the service role so browser code cannot
// flip is_default / apex_authorized / assigned_exchange_connection_id
// directly. Ownership is re-checked on every action.
//
// Actions:
//   set_default        { connection_id }
//   rename             { connection_id, label }
//   set_apex_authorized{ connection_id, authorized, force? }
//   assign_to_exchange { connection_id, exchange_connection_id | null }
//   disconnect         { connection_id, force? }
//   remove             { connection_id, force? }
//
// Refusal semantics:
//   - disconnect / remove: blocked when the wallet is the assigned wallet
//     of an ApeX exchange connection OR positions/open orders exist on any
//     exchange it's assigned to. Override with force=true.
//   - set_apex_authorized(false): blocked when the wallet is assigned to
//     an ApeX exchange connection, unless force=true (also clears the
//     assignment on the ApeX side).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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
function ok(body: Record<string, unknown> = {}) {
  return json(200, { ok: true, ...body });
}
function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return json(status, { ok: false, code, message, ...extra });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST required.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE) return fail(500, "CONFIG_ERROR", "Backend is not configured.");

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return fail(401, "UNAUTHENTICATED", "Sign in required.");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return fail(401, "UNAUTHENTICATED", "Sign in required.");
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail(400, "INVALID_BODY", "Invalid JSON body."); }

  const action = String(body.action ?? "");
  const connectionId = String(body.connection_id ?? "");
  if (!connectionId) return fail(400, "INVALID_INPUT", "connection_id required.");
  const force = body.force === true;

  // Ownership + wallet row
  const { data: wallet } = await admin
    .from("wallet_connections")
    .select("id, user_id, provider, chain, apex_authorized, is_default, assigned_exchange_connection_id, label")
    .eq("id", connectionId)
    .maybeSingle();
  if (!wallet || wallet.user_id !== userId) return fail(404, "NOT_FOUND", "Wallet not found.");

  const now = new Date().toISOString();

  // Small helper — find ApeX exchange_connection rows currently assigned to
  // this wallet (via wallet_connections.assigned_exchange_connection_id).
  async function assignedApexExchangeIds(): Promise<string[]> {
    // We assign in the reverse direction: wallet -> exchange. Look up all
    // exchange_connections whose id matches this wallet's assignment.
    if (!wallet.assigned_exchange_connection_id) return [];
    const { data } = await admin
      .from("exchange_connections")
      .select("id, exchange, status")
      .eq("id", wallet.assigned_exchange_connection_id)
      .eq("user_id", userId);
    return (data ?? [])
      .filter((r) => (r.exchange ?? "").toLowerCase().startsWith("apex"))
      .map((r) => r.id as string);
  }

  async function hasActiveTradingActivity(): Promise<boolean> {
    if (!wallet.assigned_exchange_connection_id) return false;
    const { count: posCount } = await admin
      .from("positions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("connection_id", wallet.assigned_exchange_connection_id);
    if ((posCount ?? 0) > 0) return true;
    const { count: orderCount } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("connection_id", wallet.assigned_exchange_connection_id)
      .in("status", ["open", "new", "pending", "partially_filled"]);
    return (orderCount ?? 0) > 0;
  }

  // ── set_default ────────────────────────────────────────────────────────
  if (action === "set_default") {
    // Zero out other defaults for this user, then set this one.
    const { error: clr } = await admin
      .from("wallet_connections")
      .update({ is_default: false })
      .eq("user_id", userId)
      .neq("id", connectionId);
    if (clr) return fail(500, "UPDATE_FAILED", "Could not clear existing default.");
    const { error } = await admin
      .from("wallet_connections")
      .update({ is_default: true, is_active: true, last_seen_at: now, last_error: null, last_error_at: null })
      .eq("id", connectionId);
    if (error) return fail(500, "UPDATE_FAILED", "Could not set default wallet.");
    return ok({ connection_id: connectionId });
  }

  // ── rename ─────────────────────────────────────────────────────────────
  if (action === "rename") {
    const raw = typeof body.label === "string" ? body.label.trim() : "";
    if (raw.length < 1 || raw.length > 40) {
      return fail(400, "INVALID_INPUT", "Label must be 1–40 characters.");
    }
    const { error } = await admin
      .from("wallet_connections")
      .update({ label: raw })
      .eq("id", connectionId);
    if (error) return fail(500, "UPDATE_FAILED", "Could not rename wallet.");
    return ok({ connection_id: connectionId, label: raw });
  }

  // ── set_apex_authorized ────────────────────────────────────────────────
  if (action === "set_apex_authorized") {
    const authorized = body.authorized === true;
    if (!authorized) {
      const apexIds = await assignedApexExchangeIds();
      if (apexIds.length > 0 && !force) {
        return fail(409, "APEX_ASSIGNMENT_ACTIVE",
          "This wallet is currently assigned to an ApeX connection. Confirm to revoke.",
          { assigned_exchange_connection_ids: apexIds });
      }
      if (apexIds.length > 0 && force) {
        // Clear assignment on the wallet side too.
        await admin
          .from("wallet_connections")
          .update({ assigned_exchange_connection_id: null })
          .eq("id", connectionId);
      }
    }
    const { error } = await admin
      .from("wallet_connections")
      .update({ apex_authorized: authorized })
      .eq("id", connectionId);
    if (error) return fail(500, "UPDATE_FAILED", "Could not update ApeX authorization.");
    return ok({ connection_id: connectionId, apex_authorized: authorized });
  }

  // ── assign_to_exchange ─────────────────────────────────────────────────
  if (action === "assign_to_exchange") {
    const rawExch = body.exchange_connection_id;
    if (rawExch !== null && typeof rawExch !== "string") {
      return fail(400, "INVALID_INPUT", "exchange_connection_id must be a string or null.");
    }
    let exchangeConnectionId: string | null = null;
    if (rawExch) {
      const { data: exch } = await admin
        .from("exchange_connections")
        .select("id, user_id, exchange")
        .eq("id", rawExch)
        .maybeSingle();
      if (!exch || exch.user_id !== userId) {
        return fail(404, "EXCHANGE_NOT_FOUND", "Exchange connection not found.");
      }
      // If assigning to ApeX, wallet must be apex-authorized.
      if ((exch.exchange ?? "").toLowerCase().startsWith("apex") && !wallet.apex_authorized) {
        return fail(409, "APEX_NOT_AUTHORIZED",
          "Authorize this wallet for ApeX before assigning it.");
      }
      exchangeConnectionId = exch.id as string;
    }
    const { error } = await admin
      .from("wallet_connections")
      .update({ assigned_exchange_connection_id: exchangeConnectionId })
      .eq("id", connectionId);
    if (error) return fail(500, "UPDATE_FAILED", "Could not update assignment.");
    return ok({ connection_id: connectionId, exchange_connection_id: exchangeConnectionId });
  }

  // ── disconnect ─────────────────────────────────────────────────────────
  if (action === "disconnect") {
    if (!force) {
      const apexIds = await assignedApexExchangeIds();
      if (apexIds.length > 0) {
        return fail(409, "APEX_ASSIGNMENT_ACTIVE",
          "Wallet is the assigned ApeX wallet. Reassign or confirm to override.",
          { assigned_exchange_connection_ids: apexIds });
      }
      if (await hasActiveTradingActivity()) {
        return fail(409, "TRADING_ACTIVITY",
          "Open positions or orders exist on this wallet's exchange. Close them or confirm to override.");
      }
    }
    const { error } = await admin
      .from("wallet_connections")
      .update({
        is_active: false,
        is_default: false,
        status: "disconnected",
        disconnected_at: now,
      })
      .eq("id", connectionId);
    if (error) return fail(500, "UPDATE_FAILED", "Could not disconnect wallet.");
    return ok({ connection_id: connectionId, status: "disconnected" });
  }

  // ── remove ─────────────────────────────────────────────────────────────
  if (action === "remove") {
    if (!force) {
      const apexIds = await assignedApexExchangeIds();
      if (apexIds.length > 0) {
        return fail(409, "APEX_ASSIGNMENT_ACTIVE",
          "Wallet is the assigned ApeX wallet. Reassign or confirm to override.",
          { assigned_exchange_connection_ids: apexIds });
      }
      if (await hasActiveTradingActivity()) {
        return fail(409, "TRADING_ACTIVITY",
          "Open positions or orders exist. Close them or confirm to override.");
      }
    }
    const { error } = await admin
      .from("wallet_connections")
      .delete()
      .eq("id", connectionId);
    if (error) return fail(500, "DELETE_FAILED", "Could not remove wallet.");
    return ok({ connection_id: connectionId, removed: true });
  }

  return fail(400, "INVALID_ACTION", "Unknown action.");
});
