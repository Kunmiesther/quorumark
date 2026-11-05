import {afterEach,describe,expect,it,vi} from "vitest";
import {render,screen,fireEvent,waitFor,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {SynFuturesActivation} from "./SynFuturesActivation";
import {activationCall,type ActivationStep} from "@/lib/exchanges/synfutures/activation";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),submit:vi.fn(),wallet:vi.fn()}));
vi.mock("@/lib/exchanges/synfutures/activation.functions",()=>({synFuturesActivation:mocks.invoke}));
vi.mock("@/lib/exchanges/synfutures/activationWallet",()=>({submitActivation:mocks.submit}));
vi.mock("@/lib/wallet/providers",()=>({getTransactionProvider:mocks.wallet}));
vi.mock("@/integrations/supabase/client",()=>({supabase:{auth:{getSession:async()=>({data:{session:{access_token:"test"}}})}}}));
const scope={owner:`0x${"11".repeat(20)}`,safe:`0x${"22".repeat(20)}`,module:`0x${"33".repeat(20)}`,operator:`0x${"44".repeat(20)}`};
const key="synfutures-activation:user:connection";
function step():ActivationStep{const now=Math.floor(Date.now()/1000),s={kind:"operator_gas" as const,amount:"500000000000000",validUntil:now+86400,expiresAt:now+120,scope,policy:{marginUsdc:"125",sessionBudgetUsdc:"250",takeProfitBps:100,lossLimitUsdc:"25",maxDailyEntries:20,acceptMonitoredExits:true as const},description:"Fund operator gas"};return {...s,call:activationCall(s)};}
function mount(live=false){return render(<QueryClientProvider client={new QueryClient()}><SynFuturesActivation userId="user" walletId="wallet" connectionId="connection" provider="metamask" owner={scope.owner} safe={scope.safe} module={scope.module} live={live}/></QueryClientProvider>);}
afterEach(()=>{cleanup();localStorage.clear();vi.clearAllMocks();});
describe("activation workflow",()=>{
 it("shows a running review while waiting for account verification",async()=>{
  let complete!: (value:unknown)=>void;
  mocks.invoke.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  mount();fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(screen.getByRole("button",{name:"Review funding and activation"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Reviewing funding and activation…"}).getAttribute("aria-busy")).toBe("true"));
  complete({status:"step",scope,step:step()});
  await waitFor(()=>expect(screen.getByRole("button",{name:"Approve this step in wallet"})).toBeTruthy());
 });
 it("never starts activation or pauses live trading on view alone",()=>{mount(true);expect(mocks.invoke).not.toHaveBeenCalled();expect(screen.getByRole("button",{name:"Review funding and activation"}).hasAttribute("disabled")).toBe(true);});
 it("persists the pending step before opening the wallet and blocks retries after unknown submission",async()=>{Object.defineProperty(navigator,"locks",{configurable:true,value:{request:async(_key:string,_options:unknown,callback:(lock:object)=>Promise<void>)=>callback({})}});mocks.invoke.mockResolvedValue({status:"step",scope,step:step()});mocks.wallet.mockResolvedValue({});mocks.submit.mockImplementation(async(_wallet:unknown,_step:unknown,_scope:unknown,before:()=>void)=>{before();expect(JSON.parse(localStorage.getItem(key)!).hash).toBeNull();throw new Error("SUBMISSION_UNCONFIRMED");});mount();fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(screen.getByRole("button",{name:"Review funding and activation"}));await waitFor(()=>expect(screen.getByRole("button",{name:"Approve this step in wallet"})).toBeTruthy());fireEvent.click(screen.getByRole("button",{name:"Approve this step in wallet"}));await waitFor(()=>expect(screen.getByText(/Wallet transaction pending/)).toBeTruthy());expect(mocks.submit).toHaveBeenCalledOnce();expect(screen.queryByRole("button",{name:"Approve this step in wallet"})).toBeNull();});
 it("restores the reviewed policy after reload and holds unknown receipts",async()=>{const pending={hash:`0x${"aa".repeat(32)}`,step:step()};localStorage.setItem(key,JSON.stringify(pending));mocks.invoke.mockResolvedValue({status:"unknown",scope});mount();expect(screen.getByDisplayValue("250")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Check confirmation and continue"}));await waitFor(()=>expect(screen.getByText(/Transaction remains unconfirmed/)).toBeTruthy());expect(localStorage.getItem(key)).not.toBeNull();expect(screen.queryByRole("button",{name:"Enable and verify live trading"})).toBeNull();});
 it("blocks activation wallet prompts while owner recovery remains pending",async()=>{Object.defineProperty(navigator,"locks",{configurable:true,value:{request:async(_key:string,_options:unknown,callback:(lock:object)=>Promise<void>)=>callback({})}});localStorage.setItem(`synfutures-owner-recovery:${['user','connection',scope.owner,scope.safe,scope.module].join(':')}`,JSON.stringify({hash:null}));mocks.invoke.mockResolvedValue({status:"step",scope,step:step()});mount();fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(screen.getByRole("button",{name:"Review funding and activation"}));await waitFor(()=>expect(screen.getByRole("button",{name:"Approve this step in wallet"})).toBeTruthy());fireEvent.click(screen.getByRole("button",{name:"Approve this step in wallet"}));await waitFor(()=>expect(screen.getByText(/confirm it before another owner action/)).toBeTruthy());expect(mocks.submit).not.toHaveBeenCalled();});

 it("shows confirmation when a saved step appears in another tab",async()=>{
  mount();const saved={hash:`0x${"aa".repeat(32)}`,step:step()};
  localStorage.setItem(key,JSON.stringify(saved));
  fireEvent(window,new StorageEvent("storage",{key}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Check confirmation and continue"})).toBeTruthy());
  expect(screen.queryByRole("button",{name:"Review funding and activation"})).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
 });
 it("restores the blocked pending step instead of leaving a submit button visible",async()=>{
  Object.defineProperty(navigator,"locks",{configurable:true,value:{request:async(_key:string,_options:unknown,callback:(lock:object)=>Promise<void>)=>callback({})}});
  mocks.invoke.mockResolvedValue({status:"step",scope,step:step()});
  mount();fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(screen.getByRole("button",{name:"Review funding and activation"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Approve this step in wallet"})).toBeTruthy());
  localStorage.setItem(key,JSON.stringify({hash:`0x${"aa".repeat(32)}`,step:step()}));
  fireEvent.click(screen.getByRole("button",{name:"Approve this step in wallet"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Check confirmation and continue"})).toBeTruthy());
  expect(screen.queryByRole("button",{name:"Approve this step in wallet"})).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
 });
});
