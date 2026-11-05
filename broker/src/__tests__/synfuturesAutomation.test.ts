import {describe,it,expect} from "vitest";
import {AutomationOrderSchema,unsupportedCampaignReason} from "../automationOrder.js";

const input={user_id:"00000000-0000-4000-8000-000000000001",connection_id:"00000000-0000-4000-8000-000000000002",
 venue:"synfutures",symbol:"BTC-USDC",side:"BUY",order_type:"MARKET",margin_usdc:"100.000001",leverage:33,
 purpose:"AUTOMATED_ENTRY",idempotency_key:"native-campaign",is_live:true};
describe("native SynFutures automation contract",()=>{
 it("passes exact decimals to its own private preflight",()=>{
  const parsed=AutomationOrderSchema.parse(input);
  expect(parsed.margin_usdc).toBe("100.000001");
  expect(unsupportedCampaignReason(parsed)).toBeNull();
 });
 it.each([{margin_usdc:100},{margin_usdc:"1e2"},{margin_usdc:"0"},{leverage:34},{leverage:true},
  {symbol:"BTC-USDT"},{symbol:"SOL-USDC"},{size:0.1},{campaign_rung_count:5},{reduce_only:true},
  {verified_account:true},{protective_exit_ready:true},{safe_address:"0x123"}])("refuses unsafe input %j",patch=>{
   expect(AutomationOrderSchema.safeParse({...input,...patch}).success).toBe(false);
 });
 it("does not expand other venues to USDC",()=>{
  expect(AutomationOrderSchema.safeParse({...input,venue:"aster"}).success).toBe(false);
 });
});
