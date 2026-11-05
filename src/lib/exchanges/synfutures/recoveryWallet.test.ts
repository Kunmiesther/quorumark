import {describe,it,expect,vi} from "vitest";
import {encodeFunctionData,parseAbi,encodePacked} from "viem";
import {assertSynRecovery,submitSynRecovery,type SynRecovery} from "./recoveryWallet";
const owner=`0x${"11".repeat(20)}`,safe=`0x${"22".repeat(20)}`,module=`0x${"33".repeat(20)}`,instrument="0xec6c44e704eb1932ec5fe1e4aba58db6fee71460";
const scope={owner,safe,module};
const abi=parseAbi(["function executeTrade((uint256 revision,uint256 nonce,address instrument,int128 size,uint128 margin,int24 limitTick,uint32 deadline,bool reduceOnly) intent)"]);
const plan=():SynRecovery=>({phase:"close_position",symbol:"BTC-USDC",signed_position_size:"100",observed_block:"1",expires_at:Math.floor(Date.now()/1000)+120,owner_confirmation_required:true,
 call:{chain_id:8453,from:owner,to:module,value:"0x0",data:encodeFunctionData({abi,functionName:"executeTrade",args:[{revision:1n,nonce:1n,instrument,size:-100n,margin:0n,limitTick:0,deadline:Math.floor(Date.now()/1000)+120,reduceOnly:true}]})}});
function wallet(){let listener:(v:unknown)=>void=()=>{};const request=vi.fn(async({method}:{method:string})=>{
 if(method==="eth_accounts")return [owner];if(method==="eth_chainId")return "0x2105";if(method==="eth_call")return "0x";if(method==="eth_estimateGas")return "0x100";if(method==="eth_sendTransaction")return `0x${"ab".repeat(32)}`;throw Error(method);});
 return {request,on:vi.fn((e:string,f:(v:unknown)=>void)=>{if(e==="accountsChanged")listener=f;}),removeListener:vi.fn(),change:()=>listener([safe])};}
describe("owner reduction review",()=>{
 it("accepts only the reviewed opposite size with no added margin",()=>{expect(()=>assertSynRecovery(plan(),scope)).not.toThrow();
 for(const field of ["from","to"] as const){const p=plan();p.call[field]=safe;expect(()=>assertSynRecovery(p,scope)).toThrow();}});
 it("records pending before opening the wallet and sends exactly once",async()=>{const p=plan(),w=wallet(),before=vi.fn();w.request.mockImplementationOnce(async()=>[owner]);
 w.request.mockImplementation(async({method})=>{if(method==="eth_sendTransaction"){expect(before).toHaveBeenCalledOnce();return `0x${"ab".repeat(32)}`;}if(method==="eth_accounts")return [owner];if(method==="eth_chainId")return "0x2105";if(method==="eth_call")return "0x";return "0x100";});
 await submitSynRecovery(w,p,scope,before);expect(w.request.mock.calls.filter(([x])=>x.method==="eth_sendTransaction")).toHaveLength(1);});
 it("never sends after an account change during simulation",async()=>{const w=wallet();w.request.mockImplementation(async({method})=>{if(method==="eth_accounts")return [owner];if(method==="eth_chainId")return "0x2105";if(method==="eth_call"){w.change();return "0x";}return "0x100";});
 await expect(submitSynRecovery(w,plan(),scope,vi.fn())).rejects.toThrow(/changed/);expect(w.request.mock.calls.some(([x])=>x.method==="eth_sendTransaction")).toBe(false);});
 it("a missing broadcast response stays uncertain without retry",async()=>{const w=wallet();w.request.mockImplementation(async({method})=>{if(method==="eth_accounts")return [owner];if(method==="eth_chainId")return "0x2105";if(method==="eth_call")return "0x";if(method==="eth_sendTransaction")throw Error("timeout");return "0x100";});
 await expect(submitSynRecovery(w,plan(),scope,vi.fn())).rejects.toThrow("SUBMISSION_UNCONFIRMED");expect(w.request.mock.calls.filter(([x])=>x.method==="eth_sendTransaction")).toHaveLength(1);});
 it("stale review and failed simulation never open a wallet transaction",async()=>{const p=plan();p.expires_at=0;const w=wallet();await expect(submitSynRecovery(w,p,scope,vi.fn())).rejects.toThrow();expect(w.request).not.toHaveBeenCalled();});
 it("refuses malformed reductions and positive-margin entries",()=>{for(const change of [{size:100n},{size:-99n},{margin:1n},{reduceOnly:false},{instrument:safe as `0x${string}`}]){const p=plan();p.call.data=encodeFunctionData({abi,functionName:"executeTrade",args:[{revision:1n,nonce:1n,instrument,size:-100n,margin:0n,limitTick:0,deadline:Math.floor(Date.now()/1000)+120,reduceOnly:true,...change}]});expect(()=>assertSynRecovery(p,scope)).toThrow();}});
});
