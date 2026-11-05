import { beforeEach, describe, expect, it, vi } from "vitest";
import { paperDeskTicket } from "../manualDesk";
const mocks = vi.hoisted(() => ({
  review: vi.fn(), quote: vi.fn(), rpc: vi.fn(), enabled: vi.fn(), from: vi.fn(), rules: vi.fn(),
}));
vi.mock("@/lib/ai/manualCouncil.server", () => ({ performManualCouncilReview: mocks.review }));
vi.mock("../deskMarks", () => ({ fetchPaperQuote: mocks.quote }));
vi.mock("../marketRules", () => ({ fetchPaperQuantityRules: mocks.rules }));
vi.mock("../killSwitch", () => ({ isPaperEngineEnabled: mocks.enabled }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
import { executePaperDeskOrder } from "../manualDesk.server";
const ticket = paperDeskTicket.parse({
  requestId: "00000000-0000-4000-8000-000000000001", symbol: "BTC-USDT", side: "long",
  kind: "market", marginUsd: 50, leverage: 5, limitPrice: null, takeProfit: 110,
  stopLoss: 90, dcaEnabled: false, rungCount: 1, spacingPct: 0,
});
const context = { supabase: { from: mocks.from } as any, userId: "caller" };
const market = { enabled: true, market_available: true, max_leverage: 10, step_size: 0.001, min_order_size: 0.001 };
function query(data: unknown, error: unknown = null) {
  const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data, error }) };
  chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain); return chain;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockImplementation((table) => query(table === "paper_positions" ? null : market));
  mocks.enabled.mockReturnValue(true);
  mocks.review.mockResolvedValue({ availableRoles: ["risk_officer"] });
  mocks.quote.mockResolvedValue({ symbol: "BTCUSDT", price: 100, fetchedAt: Date.now() });
  mocks.rpc.mockResolvedValue({ data: { position_id: "paper-id" }, error: null });
  mocks.rules.mockResolvedValue({ stepSize: 0.1, minOrderSize: 0.1 });
});
describe("paper desk execution", () => {
  it("resolves missing legacy precision from public metadata for a valid SOL ticket", async () => {
    mocks.from.mockImplementation((table) => query(table === "paper_positions" ? null
      : { ...market, step_size: null, min_order_size: null }));
    mocks.quote.mockResolvedValue({ symbol: "SOLUSDT", price: 122, fetchedAt: Date.now() });
    await executePaperDeskOrder(context, { ...ticket, symbol: "SOL-USDT", side: "short",
      marginUsd: 15, leverage: 1, takeProfit: null, stopLoss: null });
    expect(mocks.rules).toHaveBeenCalledWith("SOL-USDT");
    expect(mocks.rpc.mock.calls[0][1]._payload.size_qty).toBe(0.1);
    expect(mocks.rpc.mock.calls[0][1]._payload.margin).toBeLessThanOrEqual(15);
  });
  it("does not bypass the venue minimum for a $5 SOL ticket", async () => {
    mocks.from.mockImplementation((table) => query(table === "paper_positions" ? null
      : { ...market, step_size: null, min_order_size: null }));
    mocks.quote.mockResolvedValue({ symbol: "SOLUSDT", price: 122, fetchedAt: Date.now() });
    await expect(executePaperDeskOrder(context, { ...ticket, symbol: "SOL-USDT", side: "short",
      marginUsd: 5, leverage: 1, takeProfit: null, stopLoss: null })).rejects.toThrow("minimum quantity");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("fails before Council or submission when missing precision cannot be verified", async () => {
    mocks.from.mockImplementation((table) => query(table === "paper_positions" ? null
      : { ...market, step_size: null }));
    mocks.rules.mockRejectedValue(new Error("metadata unavailable"));
    await expect(executePaperDeskOrder(context, ticket)).rejects.toThrow("metadata unavailable");
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("reviews on the server then refreshes pricing and submits only to the paper RPC", async () => {
    expect(await executePaperDeskOrder(context, ticket)).toEqual({ orderId: "paper-id", status: "Paper submission confirmed" });
    expect(mocks.review.mock.invocationCallOrder[0]).toBeLessThan(mocks.quote.mock.invocationCallOrder[0]);
    const [rpc, args] = mocks.rpc.mock.calls[0];
    expect(rpc).toBe("paper_manual_open_position");
    expect(args._user_id).toBe("caller");
    expect(args._payload.wallet_key).toBe("long");
    expect(args._payload.margin).toBeLessThanOrEqual(50);
    expect(args._payload.leverage).toBe(5);
    expect(args._payload.tp_level).toBe(110);
    expect(args._payload.stop_level).toBe(90);
  });
  it("replays a confirmed request without requiring another Council call or fill", async () => {
    mocks.from.mockReturnValue(query({ id: "existing", strategy_metadata: { manual_ticket: ticket } }));
    expect((await executePaperDeskOrder(context, ticket)).orderId).toBe("existing");
    expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects changed tickets reusing a request ID", async () => {
    mocks.from.mockReturnValue(query({ id: "existing", strategy_metadata: { manual_ticket: { ...ticket, marginUsd: 60 } } }));
    await expect(executePaperDeskOrder(context, ticket)).rejects.toThrow("different ticket");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not submit if every Council seat failed", async () => {
    mocks.review.mockResolvedValue({ availableRoles: [] });
    await expect(executePaperDeskOrder(context, ticket)).rejects.toThrow("Council did not respond");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("respects pause and leverage configuration", async () => {
    mocks.enabled.mockReturnValue(false);
    await expect(executePaperDeskOrder(context, ticket)).rejects.toThrow("paused");
    mocks.enabled.mockReturnValue(true);
    await expect(executePaperDeskOrder(context, { ...ticket, leverage: 11 })).rejects.toThrow("maximum");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not submit on fresh-price protection failure", async () => {
    mocks.quote.mockResolvedValue({ price: 112, fetchedAt: Date.now() });
    await expect(executePaperDeskOrder(context, ticket)).rejects.toThrow("Take profit");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("surfaces a useful balance rejection without raw database internals", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "paper_manual_balance: private detail" } });
    await expect(executePaperDeskOrder(context, ticket)).rejects.toThrow("Insufficient available paper margin.");
  });
  it("never acknowledges a missing database result", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await expect(executePaperDeskOrder(context, ticket)).rejects.toThrow("acknowledgement is missing");
  });
});
