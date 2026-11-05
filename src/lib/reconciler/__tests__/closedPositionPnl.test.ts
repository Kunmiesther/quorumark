// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { reconcileClosedPositionPnl, reconcileApexReportedPnl } from "../../../../supabase/functions/_shared/closed-position-pnl";

const connection = { id: "connection", user_id: "owner", exchange: "aster" };
describe("closed P&L reconciliation transport", () => {
  it("uses the separate ApeX reported-P&L validator only for ApeX", async () => {
    const rpc = vi.fn().mockResolvedValue({data:{applied:true,results:[]},error:null});
    await reconcileApexReportedPnl({rpc},connection);
    expect(rpc).not.toHaveBeenCalled();
    await reconcileApexReportedPnl({rpc},{...connection,exchange:'apex_omni'});
    expect(rpc).toHaveBeenCalledExactlyOnceWith('reconcile_apex_reported_pnl',{
      p_user_id:'owner',p_connection_id:'connection',p_apply:true,
    });
  });
  it.each(["aster", "apex_omni"])("scopes %s accounting to its owner and connection", async exchange => {
    const rpc = vi.fn().mockResolvedValue({ data: { applied: true, results: [
      { status: "SETTLED", realized_pnl: 0 }, { status: "POSITION_TRADE_MISMATCH" },
    ] }, error: null });
    expect(await reconcileClosedPositionPnl({ rpc }, { ...connection, exchange }))
      .toMatchObject({ status: "checked", settled: 1, unresolved: 1 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("reconcile_closed_position_pnl", {
      p_user_id: "owner", p_connection_id: "connection", p_apply: true,
    });
  });
  it("does not apply another venue's accounting assumptions to SynFutures", async () => {
    const rpc = vi.fn();
    expect(await reconcileClosedPositionPnl({ rpc }, { ...connection, exchange: "synfutures" }))
      .toMatchObject({ status: "not_applicable" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([{ data: null, error: {} }, { data: {}, error: null },
    { data: { applied: false, results: [] }, error: null }])("reports failed evidence without claiming success", async response => {
    expect(await reconcileClosedPositionPnl({ rpc: vi.fn().mockResolvedValue(response) }, connection))
      .toEqual({ status: "failed", reason: "CLOSED_PNL_RECONCILIATION_FAILED" });
  });
  it("isolates transport failure and never returns raw errors", async () => {
    expect(await reconcileClosedPositionPnl({ rpc: vi.fn().mockRejectedValue(new Error("secret")) }, connection))
      .toEqual({ status: "failed", reason: "CLOSED_PNL_RECONCILIATION_FAILED" });
  });
});
