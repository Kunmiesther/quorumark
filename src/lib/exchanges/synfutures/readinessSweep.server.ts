import type { SupabaseClient } from "@supabase/supabase-js";
import { inspectSynFuturesAccount } from "./account.server";
import { reconcileConnections } from "../../../../supabase/functions/_shared/live-position-close";

/** Server-only observations of registered, owned accounts. Never signs or activates. */
export async function runSynFuturesReadinessSweep(
  db: SupabaseClient,
  inspect: typeof inspectSynFuturesAccount = inspectSynFuturesAccount,
) {
  const { data: registrations, error } = await db.from("synfutures_account_registrations")
    .select("user_id,wallet_id,owner_address,safe_address,module_address,setup_revision,status")
    .eq("chain_id", 8453).limit(50);
  if (error) throw new Error("SYNFUTURES_REGISTRATION_READ_FAILED");
  const rows = registrations ?? [];
  const results = await reconcileConnections(rows, async registration => {
    const { data: wallet, error: walletError } = await db.from("wallet_connections")
      .select("public_address").eq("id", registration.wallet_id).eq("user_id", registration.user_id)
      .eq("status", "verified").eq("is_active", true).eq("chain", "ethereum").eq("network", "mainnet").maybeSingle();
    if (walletError || !wallet || wallet.public_address.toLowerCase() !== registration.owner_address.toLowerCase())
      throw new Error("SYNFUTURES_OWNERSHIP_UNVERIFIED");
    const account = await inspect(wallet.public_address, registration.wallet_id);
    if (account.address.toLowerCase() !== registration.safe_address.toLowerCase() ||
        account.module.toLowerCase() !== registration.module_address.toLowerCase()) throw new Error("SYNFUTURES_ACCOUNT_BINDING_UNVERIFIED");
    const { error: auditError } = await db.from("bot_events").insert({
      user_id: registration.user_id, level: account.readiness.blockers.length ? "warn" : "info",
      event: "SYNFUTURES_READINESS_OBSERVED",
      detail: { wallet_id: registration.wallet_id, observed_block: account.observed_block,
        execution_ready: account.execution_ready, blockers: account.readiness.blockers },
    });
    if (auditError) throw new Error("SYNFUTURES_READINESS_PERSIST_FAILED");
    return { ok: true, blocked: account.readiness.blockers.length > 0 };
  }, () => ({ ok: false, blocked: true }));
  return { scanned: rows.length, observed: results.filter(result => result.ok).length,
    blocked: results.filter(result => result.blocked).length, failed: results.filter(result => !result.ok).length };
}
