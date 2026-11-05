import {decodeFunctionData,parseAbi,encodePacked} from "viem";
import type {Eip1193Provider} from "@/lib/wallet/providers";
export type SynRecovery={phase:"enable_module"|"authorize_owner_exit"|"close_position";symbol:"BTC-USDC"|"ETH-USDC";
  signed_position_size:string;observed_block:string;expires_at:number;owner_confirmation_required:true;
  call:{chain_id:8453;from:string;to:string;value:"0x0";data:string}};
export type SynRecoveryScope={owner:string;safe:string;module:string};
const zero="0x0000000000000000000000000000000000000000";
const safeAbi=parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)"]);
const moduleAbi=parseAbi(["function configureSession(address operator,uint48 validUntil,uint128 marginBudget,uint16 maxSlippageBps)",
  "function executeTrade((uint256 revision,uint256 nonce,address instrument,int128 size,uint128 margin,int24 limitTick,uint32 deadline,bool reduceOnly) intent)"]);
const enableAbi=parseAbi(["function enableModule(address module)"]);
const markets={"BTC-USDC":"0xec6c44e704eb1932ec5fe1e4aba58db6fee71460","ETH-USDC":"0x04d72fb4803b4e02f14971e5bd092375eb330749"};
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function assertSynRecovery(plan:SynRecovery,scope:SynRecoveryScope,now=Math.floor(Date.now()/1000)){
  const reject=()=>{throw new Error("Recovery review does not match this account. Refresh it before signing.");};
  if (plan.call.chain_id!==8453 || !same(plan.call.from,scope.owner) || plan.call.value!=="0x0"
    || !plan.owner_confirmation_required || plan.expires_at<=now || plan.expires_at>now+120 || !markets[plan.symbol])reject();
  if (plan.phase==="close_position"){
    if (!same(plan.call.to,scope.module))reject();
    const decoded=decodeFunctionData({abi:moduleAbi,data:plan.call.data as `0x${string}`});
    if (decoded.functionName!=="executeTrade")reject();
    if (decoded.functionName!=="executeTrade")return;
    const t=decoded.args[0];const held=BigInt(plan.signed_position_size);
    if (!same(t.instrument,markets[plan.symbol]) || held===0n || t.size!==-held || t.margin!==0n
      || !t.reduceOnly || Number(t.deadline)<=now || Number(t.deadline)>now+120)reject();
  } else {
    if (!same(plan.call.to,scope.safe))reject();
    const decoded=decodeFunctionData({abi:safeAbi,data:plan.call.data as `0x${string}`});
    const [to,value,data,operation,safeGas,baseGas,gasPrice,gasToken,refund,signatures]=decoded.args;
    const expected=encodePacked(["bytes32","bytes32","uint8"],[`0x${scope.owner.slice(2).padStart(64,"0")}`,`0x${"00".repeat(32)}`,1]);
    if (value!==0n || operation!==0 || safeGas!==0n || baseGas!==0n || gasPrice!==0n || !same(gasToken,zero)
      || !same(refund,zero) || !same(signatures,expected))reject();
    if (plan.phase==="enable_module"){
      if (!same(to,scope.safe))reject();
      const inner=decodeFunctionData({abi:enableAbi,data});
      if (!same(inner.args[0],scope.module))reject();
    } else if (plan.phase==="authorize_owner_exit"){
      if (!same(to,scope.module))reject();
      const inner=decodeFunctionData({abi:moduleAbi,data});
      if (inner.functionName!=="configureSession")reject();
      if (inner.functionName!=="configureSession")return;
      const [operator,until,budget,bps]=inner.args;
      if (!same(operator,scope.owner) || budget!==1n || Number(until)<=now+30 || Number(until)>now+300 || bps<1 || bps>1000)reject();
    } else reject();
  }
}

/** Explicit owner click only. No automatic retry, transfer, approval or deposit. */
export async function submitSynRecovery(provider:Eip1193Provider,plan:SynRecovery,scope:SynRecoveryScope,
  beforeSend:()=>void,stillCurrent:()=>boolean=()=>true){
  let invalid=false;let sending=false;
  const ownerMatches=(value:unknown)=>Array.isArray(value)&&typeof value[0]==="string"&&same(value[0],scope.owner);
  const baseMatches=(value:unknown)=>typeof value==="string"&&/^0x[0-9a-f]+$/i.test(value)&&BigInt(value)===8453n;
  const accounts=(value:unknown)=>{if (!ownerMatches(value))invalid=true;};
  const chain=(value:unknown)=>{if (!baseMatches(value))invalid=true;};
  const disconnected=()=>{invalid=true;};
  const check=async()=>{
    assertSynRecovery(plan,scope);
    if (invalid || !stillCurrent())throw new Error("Wallet or recovery review changed. Refresh before signing.");
    if (!ownerMatches(await provider.request({method:"eth_accounts"})))throw new Error("Select the registered owner in your wallet.");
    if (!baseMatches(await provider.request({method:"eth_chainId"})))throw new Error("Switch your wallet to Base, then refresh this recovery review.");
    if (invalid || !stillCurrent())throw new Error("Wallet or recovery review changed. Refresh before signing.");
  };
  provider.on?.("accountsChanged",accounts);provider.on?.("chainChanged",chain);provider.on?.("disconnect",disconnected);
  try {
    await check();const {chain_id:_chain,...tx}=plan.call;
    const simulation=await provider.request({method:"eth_call",params:[tx,"pending"]});
    if (plan.phase==="close_position"?simulation!=="0x":typeof simulation!=="string"||!/^0x0{63}1$/i.test(simulation))
      throw new Error("Recovery simulation did not succeed. Refresh before signing.");
    await provider.request({method:"eth_estimateGas",params:[tx]});await check();
    beforeSend();sending=true;
    const hash=await provider.request({method:"eth_sendTransaction",params:[tx]});
    if (typeof hash!=="string"||!/^0x[0-9a-f]{64}$/i.test(hash))throw new Error("No transaction hash returned.");
    return hash;
  } catch(error){
    if ((error as {code?:number})?.code===4001)throw new Error("OWNER_REJECTED");
    if (sending)throw new Error("SUBMISSION_UNCONFIRMED");
    throw error instanceof Error?error:new Error("Recovery preflight failed.");
  } finally {
    provider.removeListener?.("accountsChanged",accounts);provider.removeListener?.("chainChanged",chain);provider.removeListener?.("disconnect",disconnected);
  }
}
