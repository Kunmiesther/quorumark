import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const fail = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/** Called only after worker-ingest's HMAC, replay and rate checks. No caller-
 * selected RPC/table/endpoint, credentials or raw signed bytes cross this API. */
export async function handleSynFuturesLedger(admin: SupabaseClient, payload: Record<string, unknown>): Promise<Response> {
  const user = String(payload.user_id ?? ""), connection = String(payload.connection_id ?? "");
  if (!UUID.test(user) || !UUID.test(connection)) return fail(400, "BAD_SYNFUTURES_SCOPE");
  const { data: owned, error } = await admin.from("exchange_connections").select("id,permission_scopes,status,permission_trade,permissions_verified,is_live")
    .eq("id", connection).eq("user_id", user).eq("exchange", "synfutures")
    .in("environment", ["mainnet", "production"]).maybeSingle();
  if (error || !owned) return fail(409, "SYNFUTURES_CONNECTION_UNCONFIRMED");
  const op=String(payload.operation);
  const scope={p_user_id:user,p_connection_id:connection};
  if (op==="SYNFUTURES_CAMPAIGN_CONTEXT") {
    const result=await admin.rpc("synfutures_campaign_context",scope);
    return result.error?fail(503,"SYNFUTURES_CAMPAIGN_CONTEXT_UNAVAILABLE"):Response.json({ok:true,result:result.data});
  }
  if (op==="SYNFUTURES_MONITOR_WRITE") {
    const snapshot=payload.snapshot as Record<string,unknown>|null;
    if (!snapshot || JSON.stringify(snapshot).length>12000 || snapshot.chain_id!==8453
      || typeof snapshot.observed_block!=="string" || !/^\d{1,16}$/.test(snapshot.observed_block)
      || typeof snapshot.block_hash!=="string" || !HASH.test(snapshot.block_hash)) return fail(400,"BAD_SYNFUTURES_SNAPSHOT");
    // This record is display/monitor telemetry, never an entry-authority flag.
    const allowed=new Set(["chain_id","safe_address","module_address","owner_address","operator_address","session_valid_until","slippage_bps","margin_budget","margin_spent","reserve","module_revision","module_nonce","module_enabled","operator_exit_available","live_entry_allowed","positions","observed_block","block_hash","timestamp","decisions","protection_type","entries_enabled"]);
    if (Object.keys(snapshot).some(k=>!allowed.has(k))) return fail(400,"BAD_SYNFUTURES_SNAPSHOT");
    const positionKeys=new Set(["instrument_address","signed_size","balance","entry_notional","mark","close_notional","close_fee"]);
    const positions=snapshot.positions as Record<string,Record<string,unknown>>;
    if (!positions || Object.keys(positions).some(k=>!["BTC-USDC","ETH-USDC"].includes(k))
      || Object.values(positions).some(p=>!p || Object.keys(p).some(k=>!positionKeys.has(k)))) return fail(400,"BAD_SYNFUTURES_SNAPSHOT");
    const result=await admin.rpc("write_synfutures_monitor",{...scope,p_snapshot:snapshot});
    return result.error?fail(503,"SYNFUTURES_SNAPSHOT_NOT_COMMITTED"):Response.json({ok:true,result:true});
  }
  if (op==="SYNFUTURES_CAMPAIGN_CREATE") {
    if (typeof payload.campaign_key!=="string" || payload.campaign_key.length<8 || payload.campaign_key.length>64
      || typeof payload.module_revision!=="string" || !/^\d{1,78}$/.test(payload.module_revision)
      || typeof payload.size!=="string" || !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(payload.size)
      || !payload.plan || typeof payload.plan!=="object" || JSON.stringify(payload.plan).length>3000)
      return fail(400,"BAD_SYNFUTURES_CAMPAIGN");
    const result=await admin.rpc("create_synfutures_campaign",{...scope,p_key:payload.campaign_key,p_plan:payload.plan,
      p_revision:payload.module_revision,p_size:payload.size});
    return result.error?fail(409,"SYNFUTURES_CAMPAIGN_NOT_COMMITTED"):Response.json({ok:true,result:result.data});
  }
  if (["SYNFUTURES_CAMPAIGN_CLAIM","SYNFUTURES_ACTION_PREPARE","SYNFUTURES_CAMPAIGN_FINISH","SYNFUTURES_ACTION_FAIL","SYNFUTURES_CAMPAIGN_SETTLE"].includes(op)) {
    if (typeof payload.campaign_id!=="string" || !UUID.test(payload.campaign_id)
      || typeof payload.token!=="string" || !UUID.test(payload.token)) return fail(400,"BAD_SYNFUTURES_CAMPAIGN_SCOPE");
    const args={...scope,p_campaign_id:payload.campaign_id,p_token:payload.token};
    let result;
    if (op==="SYNFUTURES_CAMPAIGN_CLAIM") result=await admin.rpc("claim_synfutures_campaign",args);
    else if (op==="SYNFUTURES_ACTION_FAIL") {
      if (typeof payload.intent_id!=="string" || !UUID.test(payload.intent_id)) return fail(400,"BAD_SYNFUTURES_INTENT");
      result=await admin.rpc("fail_synfutures_action",{...args,p_intent_id:payload.intent_id});
    } else if (op==="SYNFUTURES_CAMPAIGN_SETTLE") {
      if (!payload.proof || typeof payload.proof!=="object" || JSON.stringify(payload.proof).length>2000) return fail(400,"BAD_SYNFUTURES_SETTLEMENT");
      result=await admin.rpc("settle_synfutures_campaign",{...args,p_proof:payload.proof});
    } else if (op==="SYNFUTURES_ACTION_PREPARE") {
      if (!["entry","exit"].includes(String(payload.kind)) || typeof payload.rung!=="number" || !Number.isInteger(payload.rung)
        || typeof payload.size!=="string" || !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(payload.size)
        || typeof payload.reason!=="string" || !/^SYNFUTURES_[A-Z_]{1,80}$/.test(payload.reason)) return fail(400,"BAD_SYNFUTURES_ACTION");
      result=await admin.rpc("prepare_synfutures_action",{...args,p_kind:payload.kind,p_rung:payload.rung,p_size:payload.size,p_reason:payload.reason});
    } else {
      if (!["waiting","active","closing","closed","cancelled","recovery_required"].includes(String(payload.status))
        || typeof payload.reason!=="string" || !/^SYNFUTURES_[A-Z_]{1,80}$/.test(payload.reason)) return fail(400,"BAD_SYNFUTURES_CAMPAIGN_STATUS");
      result=await admin.rpc("finish_synfutures_campaign",{...args,p_status:payload.status,p_reason:payload.reason});
    }
    return result.error?fail(409,"SYNFUTURES_CAMPAIGN_STATE_UNCONFIRMED"):Response.json({ok:true,result:result.data});
  }
  if (op==="SYNFUTURES_PROVISIONAL_RECORD") {
    if (typeof payload.intent_id!=="string" || !UUID.test(payload.intent_id) || typeof payload.tx_hash!=="string" || !HASH.test(payload.tx_hash)
      || (payload.block!==null && (typeof payload.block!=="number" || !Number.isSafeInteger(payload.block) || payload.block<0))
      || (payload.block_hash!==null && (typeof payload.block_hash!=="string" || !HASH.test(payload.block_hash)))) return fail(400,"BAD_SYNFUTURES_PROVISIONAL");
    const result=await admin.rpc("record_synfutures_provisional",{...scope,p_intent_id:payload.intent_id,p_hash:payload.tx_hash,p_block:payload.block,p_block_hash:payload.block_hash});
    return result.error?fail(409,"SYNFUTURES_PROVISIONAL_UNCONFIRMED"):Response.json({ok:true,result:result.data});
  }
  if (payload.operation === "SYNFUTURES_ACCOUNT_CONTEXT") {
    const scopes = owned.permission_scopes as Record<string, unknown> | null;
    if (!scopes || typeof scopes.registration_id !== "string" || !UUID.test(scopes.registration_id)
      || typeof scopes.wallet_id !== "string" || !UUID.test(scopes.wallet_id)) return fail(409, "SYNFUTURES_BINDING_UNCONFIRMED");
    const registration = await admin.from("synfutures_account_registrations")
      .select("wallet_id,chain_id,owner_address,safe_address,module_address,safe_proxy_code_hash,module_code_hash")
      .eq("id", scopes.registration_id).eq("user_id", user).eq("wallet_id", scopes.wallet_id).eq("chain_id", 8453).maybeSingle();
    const reg = registration.data;
    if (registration.error || !reg || reg.owner_address !== scopes.owner_address || reg.safe_address !== scopes.safe_address
      || reg.module_address !== scopes.module_address) return fail(409, "SYNFUTURES_BINDING_UNCONFIRMED");
    const wallet = await admin.from("wallet_connections").select("public_address")
      .eq("id", reg.wallet_id).eq("user_id", user).eq("status", "verified").eq("is_active", true)
      .eq("chain", "ethereum").eq("network", "mainnet").maybeSingle();
    if (wallet.error || wallet.data?.public_address?.toLowerCase() !== reg.owner_address)
      return fail(409, "SYNFUTURES_OWNER_UNCONFIRMED");
    return Response.json({ ok: true, context: { ...reg, live_entry_allowed: owned.status === "verified"
      && owned.permission_trade === true && owned.permissions_verified === true && owned.is_live === true } });
  }
  if (payload.operation === "SYNFUTURES_TRANSACTIONS_LIST") {
    // PostgREST numeric JSON would lose uint128/256 precision in JS. Read the
    // integer fields as text through the dedicated RPC instead.
    const exact = await admin.rpc("list_synfutures_transactions", { p_user_id: user, p_connection_id: connection });
    if (exact.error || !Array.isArray(exact.data)) return fail(503, "SYNFUTURES_JOURNAL_UNAVAILABLE");
    return Response.json({ ok: true, transactions: exact.data });
  }
  const intent = String(payload.intent_id ?? "");
  if (!UUID.test(intent)) return fail(400, "BAD_SYNFUTURES_INTENT");
  if (payload.operation === "SYNFUTURES_TRANSACTION_RESERVE") {
    const tx = payload.transaction as Record<string, unknown> | undefined;
    if (!tx || typeof tx !== "object" || Array.isArray(tx)) return fail(400, "BAD_SYNFUTURES_TRANSACTION");
    for (const key of ["operator_address", "module_address", "safe_address", "instrument_address"]) {
      if (typeof tx[key] !== "string" || !ADDRESS.test(tx[key] as string)) return fail(400, "BAD_SYNFUTURES_ADDRESS");
    }
    for (const key of ["operator_nonce", "module_revision", "module_nonce", "signed_size", "margin"]) {
      if (typeof tx[key] !== "string" || !/^-?\d{1,78}$/.test(tx[key] as string)) return fail(400, "BAD_SYNFUTURES_INTEGER");
    }
    if (typeof tx.reduce_only !== "boolean" || typeof tx.tx_hash !== "string" || !HASH.test(tx.tx_hash)) return fail(400, "BAD_SYNFUTURES_TRANSACTION");
    const result = await admin.rpc("reserve_synfutures_transaction", {
      p_user_id: user, p_connection_id: connection, p_intent_id: intent, p_tx: tx,
    });
    if (result.error) return fail(409, "SYNFUTURES_RESERVATION_NOT_COMMITTED");
    return Response.json({ ok: true, ...result.data });
  }
  if (payload.operation !== "SYNFUTURES_TRANSACTION_OBSERVE") return fail(400, "BAD_SYNFUTURES_OPERATION");
  const hash = String(payload.tx_hash ?? ""), state = String(payload.state ?? "");
  const block = payload.block ?? null, blockHash = payload.block_hash ?? null;
  if (!HASH.test(hash) || !["broadcast", "unknown", "confirmed", "reverted"].includes(state)
    || (block !== null && (typeof block !== "number" || !Number.isSafeInteger(block) || block < 0))
    || (blockHash !== null && (typeof blockHash !== "string" || !HASH.test(blockHash)))) return fail(400, "BAD_SYNFUTURES_OBSERVATION");
  const result = await admin.rpc("observe_synfutures_transaction", {
    p_user_id: user, p_connection_id: connection, p_intent_id: intent,
    p_tx_hash: hash, p_state: state, p_block: block, p_block_hash: blockHash,
  });
  if (result.error) return fail(409, "SYNFUTURES_OBSERVATION_NOT_COMMITTED");
  return Response.json({ ok: true });
}
