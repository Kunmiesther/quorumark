import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@tanstack/react-start",()=>({createServerFn:()=>({handler:(fn:unknown)=>fn})}));
import {getExecutionRuntimeHealth} from "../executionRuntime.functions";
beforeEach(()=>vi.stubEnv("TURTLE_BROKER_BASE_URL","https://broker.test"));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
function responses(venues:Record<string,boolean>,signer=true) {
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>Response.json(
    url.endsWith("/healthz") ? {ok:true,flags:{reads:true,signer:false,canary:false,automation:false,capital:false}} :
    url.endsWith("/readyz") ? {ok:signer,signer:signer?"ok":"unhealthy",aster_automation_enabled:true} :
    {ok:true,accepting_orders:Object.values(venues).some(Boolean),supported_campaign_rung_counts:[5],venues}
  )));
}
describe("runtime readiness is independent by venue",()=>{
  it("Aster readiness survives disabled ApeX flags",async()=>{
    responses({apex_omni:false,aster:true});
    expect(await getExecutionRuntimeHealth()).toMatchObject({automationTradingReady:true,manualTradingReady:false,automationVenues:{apex_omni:false,aster:true}});
  });
  it("a failed signer disables every venue",async()=>{
    responses({apex_omni:true,aster:true},false);
    expect(await getExecutionRuntimeHealth()).toMatchObject({automationTradingReady:false,automationVenues:{apex_omni:false,aster:false}});
  });
  it("an unrelated supported route cannot authorize an absent one",async()=>{
    responses({aster:false});
    expect(await getExecutionRuntimeHealth()).toMatchObject({automationTradingReady:false});
  });
});
