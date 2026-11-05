import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {render,screen,fireEvent,waitFor,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {encodeFunctionData,parseAbi} from "viem";
import {SynFuturesRecovery} from "./SynFuturesRecovery";
const mocks=vi.hoisted(()=>({read:vi.fn(),provider:vi.fn(),request:vi.fn()}));
vi.mock("@/lib/exchanges/synfutures/lifecycle.functions",()=>({synFuturesLifecycle:mocks.read}));
vi.mock("@/lib/wallet/providers",()=>({getTransactionProvider:mocks.provider}));
vi.mock("@/integrations/supabase/client",()=>({supabase:{auth:{getSession:async()=>({data:{session:{access_token:"token"}}})}}}));
const owner=`0x${"11".repeat(20)}`,safe=`0x${"22".repeat(20)}`,module=`0x${"33".repeat(20)}`;
const id="00000000-0000-4000-8000-000000000001",identity=["user",id,owner,safe,module].join(":"),key=`synfutures-owner-recovery:${identity}`;
const props={userId:"user",connectionId:id,provider:"metamask",owner,safe,module};
const snapshot={owner_address:owner,safe_address:safe,module_address:module,operator_exit_available:false,
 observed_block:"100",timestamp:Math.floor(Date.now()/1000),positions:{"BTC-USDC":{signed_size:"100"},"ETH-USDC":{signed_size:"0"}}};
function mount(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><SynFuturesRecovery {...props}/></QueryClientProvider>);}
beforeEach(()=>{localStorage.clear();mocks.read.mockResolvedValue({status:"snapshot",snapshot});Object.defineProperty(navigator,"locks",{configurable:true,value:{request:async(_name:unknown,_options:unknown,cb:(lock:unknown)=>unknown)=>cb({})}});});
afterEach(()=>{cleanup();vi.resetAllMocks();localStorage.clear();});
describe("native recovery uncertainty history",()=>{
 it("does not interpret a failed position read as flat",async()=>{mocks.read.mockRejectedValue(Error("read unavailable"));mount();expect((await screen.findByRole("alert")).textContent).toContain("Position read unavailable");expect(screen.queryByRole("button",{name:"Review owner recovery"})).toBeNull();expect(mocks.provider).not.toHaveBeenCalled();});
 it("a saved unknown wallet result blocks another transaction after reload",async()=>{localStorage.setItem(key,JSON.stringify({phase:"close_position",symbol:"BTC-USDC",hash:null,calldata_hash:`0x${"ab".repeat(32)}`}));mount();
  expect(await screen.findByText(/Recovery submission pending/)).toBeTruthy();const button=await screen.findByRole("button",{name:"Review owner recovery"});expect((button as HTMLButtonElement).disabled).toBe(true);expect(mocks.provider).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox",{name:"Recovery transaction hash"}),{target:{value:`0x${"cd".repeat(32)}`}});
  mocks.read.mockResolvedValue({status:"unknown",phase:"close_position",reconciliation_required:true});fireEvent.click(screen.getByRole("button",{name:"Verify recovery receipt"}));
  expect(await screen.findByText(/Receipt remains unconfirmed/)).toBeTruthy();expect(localStorage.getItem(key)).toContain('"hash":"0x');expect(mocks.provider).not.toHaveBeenCalled();
 });
 it("records an unknown send before wallet submission and never retries automatically",async()=>{const deadline=Math.floor(Date.now()/1000)+120;
  const abi=parseAbi(["function executeTrade((uint256 revision,uint256 nonce,address instrument,int128 size,uint128 margin,int24 limitTick,uint32 deadline,bool reduceOnly) intent)"]);
  const recovery={phase:"close_position",symbol:"BTC-USDC",signed_position_size:"100",observed_block:"100",expires_at:deadline,owner_confirmation_required:true,
   call:{chain_id:8453,from:owner,to:module,value:"0x0",data:encodeFunctionData({abi,functionName:"executeTrade",args:[{revision:1n,nonce:1n,instrument:"0xec6c44e704eb1932ec5fe1e4aba58db6fee71460",size:-100n,margin:0n,limitTick:0,deadline,reduceOnly:true}]})}};
  mocks.read.mockImplementation(async({data})=>data.operation==="positions"?{status:"snapshot",snapshot}:{status:"owner_review_required",recovery});
  mocks.request.mockImplementation(async({method})=>{if(method==="eth_accounts")return [owner];if(method==="eth_chainId")return "0x2105";if(method==="eth_call")return "0x";if(method==="eth_estimateGas")return "0x100";
   if(method==="eth_sendTransaction"){expect(localStorage.getItem(key)).toContain('"hash":null');throw Error("timeout");}throw Error(method);});mocks.provider.mockResolvedValue({request:mocks.request});
  mount();fireEvent.click(await screen.findByRole("button",{name:"Review owner recovery"}));fireEvent.click(await screen.findByRole("button",{name:"Review and confirm in wallet"}));
  expect(await screen.findByText(/Recovery submission pending/)).toBeTruthy();await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("SUBMISSION_UNCONFIRMED"));
  expect(mocks.request.mock.calls.filter(([x])=>x.method==="eth_sendTransaction")).toHaveLength(1);expect(localStorage.getItem(key)).toContain('"hash":null');
 });
});
