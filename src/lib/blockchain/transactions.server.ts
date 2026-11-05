import type { SupabaseClient } from "@supabase/supabase-js";
import { BaseError, type Hash } from "viem";
import { canonicalJson } from "@/lib/ai/committee/schema";
import { assertPlan, type SwapPlan, type SwapRecord } from "./transactions";
import type { SpotRequest } from "./spot";
import { BLOCKCHAINS, walletSupportsNetwork } from "./catalog";

export type SwapContext = { supabase: SupabaseClient; userId: string };
const TABLE = "blockchain_swap_intents";
const COLUMNS = "id,plan,status,tx_hash,transaction_nonce,hash_verified,previous_hashes,receipt";
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as SupabaseClient;
}
async function ownedWallet(ctx: SwapContext, walletId: string) {
  const result = await ctx.supabase
    .from("wallet_connections")
    .select("id,chain,network,public_address,status,is_active,provider,label")
    .eq("id", walletId)
    .eq("user_id", ctx.userId)
    .eq("is_active", true)
    .eq("status", "verified")
    .maybeSingle();
  if (result.error || !result.data) throw new Error("Select your verified wallet first.");
  return result.data;
}
async function ownedRecord(ctx: SwapContext, id: string): Promise<SwapRecord> {
  const result = await ctx.supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq("id", id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (result.error || !result.data) throw new Error("Swap record unavailable for this account.");
  return result.data as SwapRecord;
}
export async function prepareSwapRecord(
  ctx: SwapContext,
  id: string,
  request: SpotRequest,
): Promise<SwapRecord> {
  const prior = await ctx.supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq("id", id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (prior.error)
    throw new Error("Swap journal unavailable. No wallet transaction was requested.");
  if (prior.data) {
    const row = prior.data as SwapRecord;
    if (canonicalJson(row.plan.request) !== canonicalJson(request))
      throw new Error("This request ID belongs to a different swap.");
    return row;
  }
  const wallet = await ownedWallet(ctx, request.walletId);
  const [{ prepareWalletSwap }, { evaluateSnapshot }] = await Promise.all([
    import("./prepare.server"),
    import("@/lib/ai/committee/evaluate.server"),
  ]);
  const plan = await prepareWalletSwap(id, request, wallet, (snapshot) =>
    evaluateSnapshot(ctx.supabase, ctx.userId, snapshot),
  );
  const write = await admin();
  const inserted = await write
    .from(TABLE)
    .insert({
      id,
      user_id: ctx.userId,
      wallet_id: wallet.id,
      network: request.network,
      action: plan.action,
      request,
      plan,
    })
    .select(COLUMNS)
    .single();
  if (!inserted.error) return inserted.data as SwapRecord;
  if (inserted.error.code === "23505") {
    const row = await ownedRecord(ctx, id);
    if (canonicalJson(row.plan.request) === canonicalJson(request)) return row;
  }
  throw new Error("Could not save the review. No wallet transaction was requested.");
}
export async function claimSwapRecord(ctx: SwapContext, id: string): Promise<SwapPlan> {
  const row = await ownedRecord(ctx, id);
  const wallet = await ownedWallet(ctx, row.plan.request.walletId);
  const network = BLOCKCHAINS.find((item) => item.id === row.plan.request.network)!;
  if (
    !walletSupportsNetwork(wallet, network) ||
    wallet.public_address.toLowerCase() !== row.plan.owner.toLowerCase()
  )
    throw new Error("Wallet changed. Prepare a new review.");
  assertPlan(row.plan);
  // Atomic, one-time handoff. A second tab cannot prompt the same draft again.
  const result = await (
    await admin()
  )
    .from(TABLE)
    .update({ status: "signing", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", ctx.userId)
    .eq("status", "prepared")
    .select("id")
    .maybeSingle();
  if (result.error || !result.data)
    throw new Error(
      "This review was already handed to a wallet. Check its status before creating another.",
    );
  return row.plan;
}
export async function trackSwapRecord(
  ctx: SwapContext,
  id: string,
  hash: Hash,
): Promise<SwapRecord> {
  const row = await ownedRecord(ctx, id);
  if (!["signing", "submitted", "confirmed", "reverted", "cancelled"].includes(row.status))
    throw new Error("This review was not handed to a wallet.");
  const replacing = !!row.tx_hash && row.tx_hash.toLowerCase() !== hash.toLowerCase();
  if (replacing && row.status !== "submitted")
    throw new Error(
      "This transaction has already completed. A new hash cannot replace its result.",
    );
  // Persist the reported hash before the RPC read. This is only 'submitted', never a fill claim.
  if (!row.tx_hash) {
    const saved = await (
      await admin()
    )
      .from(TABLE)
      .update({
        tx_hash: hash.toLowerCase(),
        status: "submitted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", ctx.userId)
      .is("tx_hash", null)
      .select("id")
      .maybeSingle();
    if (saved.error || !saved.data)
      throw new Error(
        "Hash could not be saved. Keep the wallet transaction hash and retry status—not the swap.",
      );
  }
  const { reconcileSwapReceipt, createReceiptReader } = await import("./receipts.server");
  const rpc = createReceiptReader(row.plan);
  let nonce = row.transaction_nonce;
  if (replacing && nonce === null) {
    // A previously unobserved hash may now be visible. Preserve its verified nonce
    // so an unrelated second transaction cannot masquerade as a replacement.
    try {
      nonce = (await reconcileSwapReceipt(row.plan, row.tx_hash as Hash, rpc)).transaction_nonce;
    } catch (error) {
      // A mistyped recovery hash is correctable only with a new, exact matching transaction.
      if (!(error instanceof Error) || !error.message.startsWith("Transaction does not match"))
        throw error;
    }
  }
  const verified = await reconcileSwapReceipt(row.plan, hash, rpc, nonce);
  if (replacing && !verified.hash_verified)
    throw new Error(
      "Replacement hash is not yet visible on this chain. Keep the hash and retry status.",
    );
  const previous_hashes = replacing ? [...row.previous_hashes, row.tx_hash!] : row.previous_hashes;
  const result = await (
    await admin()
  )
    .from(TABLE)
    .update({
      ...verified,
      tx_hash: hash.toLowerCase(),
      previous_hashes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", ctx.userId)
    .eq("tx_hash", replacing ? row.tx_hash! : hash.toLowerCase())
    .select(COLUMNS)
    .single();
  if (result.error) throw new Error("Receipt journal update failed. Retry status, not the swap.");
  return result.data as SwapRecord;
}
export async function listSwapRecords(
  ctx: SwapContext,
  walletId: string,
  network: SpotRequest["network"],
) {
  const result = await ctx.supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq("user_id", ctx.userId)
    .eq("wallet_id", walletId)
    .eq("network", network)
    .order("created_at", { ascending: false })
    .limit(10);
  if (result.error) throw new Error("Swap journal unavailable.");
  return result.data as SwapRecord[];
}
export async function declineSwapRecord(ctx: SwapContext, id: string) {
  // Owner-reported rejection, not chain evidence. Never used to mark a fill or infer a balance.
  const result = await (
    await admin()
  )
    .from(TABLE)
    .update({ status: "declined", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", ctx.userId)
    .eq("status", "signing")
    .is("tx_hash", null)
    .select("id")
    .maybeSingle();
  if (result.error || !result.data)
    throw new Error("Could not record wallet rejection. Check the transaction journal.");
}
export async function safeSwapCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof BaseError)
      throw new Error(
        "Network verification unavailable. Check the journal and retry status; do not resend a submitted transaction.",
      );
    throw error;
  }
}
