import {describe,expect,it} from "vitest";
import {supportsLivePlan} from "../../../supabase/functions/_shared/live-plan-route-policy";
const connection={exchange:"aster",environment:"production",status:"verified",permission_read:true,permission_trade:true,permissions_verified:true};
describe("live plan route policy",()=>{
  it.each(["kraken","synfutures","base","solana","bydfi"])("does not save unsupported %s as an executable live route",exchange=>expect(supportsLivePlan({...connection,exchange})).toBe(false));
  it.each(["aster","apex_omni"])("accepts verified supported %s",exchange=>expect(supportsLivePlan({...connection,exchange})).toBe(true));
  it("requires trading authority and mainnet",()=>{
    expect(supportsLivePlan({...connection,permission_trade:false})).toBe(false);
    expect(supportsLivePlan({...connection,environment:"testnet"})).toBe(false);
  });
});
