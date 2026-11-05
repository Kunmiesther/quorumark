import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { performManualCouncilReview } from "@/lib/ai/manualCouncil.server";
import { fetchPaperQuote } from "./deskMarks";
import { fetchPaperQuantityRules } from "./marketRules";
import { type PaperDeskTicket, validatePaperProtection } from "./manualDesk";
import { isPaperEngineEnabled } from "./killSwitch";
import { applySlip } from "./pricing";
import { TAKER_FEE_BPS } from "@/lib/trade/manualTicket";

/** Paper-only endpoint. No broker, signer, exchange connection or live mutation. */
export async function executePaperDeskOrder(
  context: { supabase: SupabaseClient<Database>; userId: string }, ticket: PaperDeskTicket,
) {
  const prior = await context.supabase.from("paper_positions")
    .select("id,strategy_metadata")
    .eq("user_id", context.userId).eq("opened_from_signal", `manual:${ticket.requestId}`).maybeSingle();
  if (prior.error) throw new Error("Could not check prior paper submissions. Retry shortly.");
  if (prior.data) {
    const metadata = prior.data.strategy_metadata as { manual_ticket?: Record<string, unknown> } | null;
    if (!metadata?.manual_ticket || !Object.entries(ticket).every(([key, value]) => metadata.manual_ticket?.[key] === value))
      throw new Error("This submission was already used for a different ticket.");
    return { orderId: prior.data.id, status: "Paper submission confirmed" };
  }
  if (!isPaperEngineEnabled()) throw new Error("Paper engine is paused. No order was placed.");
  const { data: market, error } = await context.supabase.from("paper_test_symbols")
    .select("enabled,market_available,max_leverage,step_size,min_order_size")
    .eq("user_id", context.userId).eq("symbol", ticket.symbol).maybeSingle();
  if (error || !market?.enabled || !market.market_available)
    throw new Error("Enable this symbol in your paper setup before placing a trade.");
  if (!(market.max_leverage > 0) || ticket.leverage > market.max_leverage)
    throw new Error("Requested leverage exceeds this paper symbol's configured maximum.");
  // Older paper setups have null precision fields. Resolve public contract
  // metadata rather than treating null as zero or inventing an increment.
  const configuredStep = Number(market.step_size);
  const configuredMinimum = Number(market.min_order_size);
  const quantityRules = Number.isFinite(configuredStep) && configuredStep > 0
    && Number.isFinite(configuredMinimum) && configuredMinimum > 0
    ? { stepSize: configuredStep, minOrderSize: configuredMinimum }
    : await fetchPaperQuantityRules(ticket.symbol);
  // Server-enforced Council call: UI state is not authorization evidence.
  const review = await performManualCouncilReview({
    book: "paper", exchange: "ApeX Omni", symbol: ticket.symbol, side: ticket.side,
    leverage: ticket.leverage, margin: ticket.marginUsd, kind: "market", limitPrice: null,
    takeProfit: ticket.takeProfit, stopLoss: ticket.stopLoss, dca: false, rungCount: 1, spacingPct: 0,
  }, context);
  if (review.availableRoles.length === 0)
    throw new Error("Council did not respond. Retry the review; no paper order was placed.");
  // Refresh AFTER review so provider latency cannot turn an old quote into a fill.
  const quote = await fetchPaperQuote(ticket.symbol);
  const entry = applySlip(quote.price, ticket.side, true);
  validatePaperProtection(ticket, entry);
  const step = quantityRules.stepSize;
  const qty = Math.floor((ticket.marginUsd * ticket.leverage / entry) / step) * step;
  if (!(qty > 0) || qty < quantityRules.minOrderSize)
    throw new Error("Order amount is below this symbol's minimum quantity.");
  const margin = qty * entry / ticket.leverage;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error: openError } = await supabaseAdmin.rpc("paper_manual_open_position" as never, {
    _user_id: context.userId, _request_id: ticket.requestId,
    _ticket: ticket,
    _payload: {
      wallet_key: ticket.side, symbol: ticket.symbol, direction: ticket.side,
      strategy: "manual_ticket", entry_price: entry, entry_ts: new Date(quote.fetchedAt).toISOString(),
      entry_candle_ts_ms: Math.floor(quote.fetchedAt / 900_000) * 900_000,
      tp_level: ticket.takeProfit, stop_level: ticket.stopLoss,
      zone_lower: entry, zone_upper: entry, zone_level: entry,
      size_qty: qty, size_notional: qty * entry, margin, leverage: ticket.leverage,
      entry_fee: qty * entry * TAKER_FEE_BPS / 10_000,
      opened_from_signal: `manual:${ticket.requestId}`,
      onyx_rationale: "Manual paper ticket reviewed by Council; owner-directed entry.",
      rung_count: 1, first_fill_vwap: entry,
      fills: [{ price: entry, qty, margin, tp: ticket.takeProfit }],
      pending_rungs: [], resize_levels: [], ladder_total_margin: margin,
      ladder_total_notional: qty * entry, ladder_total_rungs: 1,
    },
  } as never);
  if (openError) {
    const token = openError.message.split(":")[0];
    const reasons: Record<string, string> = {
      paper_manual_balance: "Insufficient available paper margin.",
      paper_wallet_insufficient_collateral: "Insufficient margin in the selected paper wallet. Other wallet allocations are separate.",
      paper_manual_wallet: "The selected paper wallet is unavailable or paused.",
      paper_symbol_campaign_already_open: "There is already an open paper campaign for this symbol.",
      paper_manual_conflict: "This submission was already used for a different ticket.",
      paper_manual_account: "Initialize your paper account before trading.",
    };
    throw new Error(reasons[token] ?? "Paper order could not be confirmed. Check positions before retrying.");
  }
  const result = data as { position_id?: string } | null;
  if (!result?.position_id) throw new Error("Paper order acknowledgement is missing. Check positions before retrying.");
  return { orderId: result.position_id, status: "Paper submission confirmed" };
}
