import {createPublicClient,erc20Abi,getAddress,parseUnits,keccak256,toHex,type Address,type Hex} from "viem";
import {base} from "viem/chains";
import {chainRpcTransport} from "@/lib/blockchain/rpc.server";
import {inspectSynFuturesAccount} from "./account.server";
import {activationCall,activationContracts,assertActivationStep,requireActivationReady,type ActivationScope,type ActivationStep,type ActivationPolicy} from "./activation";
const client=()=>createPublicClient({chain:base,transport:chainRpcTransport("base")});
type Input={userId:string;connectionId:string;walletId:string;scope:ActivationScope;policy:ActivationPolicy};
async function read(input:Input){
 const {supabaseAdmin}=await import("@/integrations/supabase/client.server");
 const inflight=await supabaseAdmin.from("synfutures_campaigns" as never).select("id").eq("connection_id",input.connectionId).eq("user_id",input.userId).not("status","in","(closed,cancelled)");
 if(inflight.error||inflight.data?.length)throw new Error("Existing campaign must be reconciled before activation");
 const account=await inspectSynFuturesAccount(input.scope.owner,input.walletId);const rpc=client();const block=await rpc.getBlock({blockNumber:BigInt(account.observed_block)});
 if(account.deployment_stage!=="deployed"||getAddress(account.address)!==getAddress(input.scope.safe)||getAddress(account.module)!==getAddress(input.scope.module)||Math.abs(Date.now()/1000-Number(block.timestamp))>30||!account.balances||!account.permissions||!account.markets||!account.positions||account.positions.some(p=>p.has_exposure))throw new Error("Fresh registered flat account verification required");
 return {account,rpc,block};
}
export async function activationPlan(input:Input):Promise<ActivationStep|null>{
 const now=Math.floor(Date.now()/1000);const skeleton={kind:"session" as const,amount:"0",validUntil:now+86400,expiresAt:now+120,scope:input.scope,policy:input.policy};assertActivationStep({...skeleton,description:"Review",call:activationCall(skeleton)},input.scope,now);
 const {supabaseAdmin}=await import("@/integrations/supabase/client.server");
 const pause=await supabaseAdmin.from("exchange_connections").update({is_live:false,permission_trade:false}).eq("id",input.connectionId).eq("user_id",input.userId).eq("exchange","synfutures").select("id").single();
 if(pause.error||!pause.data)throw new Error("Could not pause entries for activation review");
 const {account,rpc,block}=await read(input);const s=input.scope,p=input.policy;const margin=parseUnits(p.marginUsdc,6),reserve=parseUnits(account.balances!.gate_reserve_usdc,6),held=parseUnits(account.balances!.usdc,6);
 const gas=await rpc.getBalance({address:s.operator as Address,blockNumber:block.number});let kind:ActivationStep["kind"];let amount=0n;let description:string;
 if(gas<300_000_000_000_000n){kind="operator_gas";amount=500_000_000_000_000n-gas;description="Fund dedicated operator gas on Base (up to 0.0005 ETH)";if(await rpc.getBalance({address:s.owner as Address,blockNumber:block.number})<amount+100_000_000_000_000n)throw new Error("Owner wallet needs more Base ETH for funding and transaction fees");}
 else if(reserve+held<margin){kind="fund_safe";amount=margin-reserve-held;description=`Transfer ${Number(amount)/1e6} USDC into your existing trading account`;const available=await rpc.readContract({address:activationContracts.usdc,abi:erc20Abi,functionName:"balanceOf",args:[s.owner as Address],blockNumber:block.number});if(available<amount)throw new Error("Owner wallet lacks the reviewed USDC allocation");}
 else if(reserve<margin){amount=margin-reserve;if(parseUnits(account.balances!.gate_allowance_usdc,6)<amount){kind="approve";description="Approve only the required USDC amount for the verified SynFutures Gate";}else{kind="deposit";description="Deposit the allocated USDC into this Safe’s SynFutures reserve";}}
 else if(!account.permissions!.module_enabled){kind="enable_module";description="Enable the existing verified trading module";}
 else {
  const index=account.markets!.findIndex(m=>m.max_leverage!==33||parseUnits(m.max_margin_per_trade_usdc,18)!==parseUnits(p.marginUsdc,18)/5n||parseUnits(m.max_notional_usdc,18)!==parseUnits(p.marginUsdc,18)*33n||parseUnits(m.max_base_size,18)!==parseUnits(m.symbol==="BTC-USDC"?"1":"10",18));
  if(index>=0){kind=account.markets![index].symbol==="BTC-USDC"?"market_btc":"market_eth";description=`Configure ${account.markets![index].symbol} at 33× with five equal margin rungs`;}
  else if(account.permissions!.operator.toLowerCase()!==s.operator.toLowerCase()||account.permissions!.valid_until<=now+600||parseUnits(account.permissions!.margin_budget_usdc,18)-parseUnits(account.permissions!.margin_spent_usdc,18)<parseUnits(p.marginUsdc,18)||parseUnits(account.permissions!.margin_budget_usdc,18)!==parseUnits(p.sessionBudgetUsdc,18)){kind="session";description=`Authorize the dedicated operator for 24 hours with a ${p.sessionBudgetUsdc} USDC cumulative margin budget and 0.5% slippage cap`;}
  else{requireActivationReady(account,s.operator,p);return null;}
 }
 const step={...skeleton,kind,amount:amount.toString(),description};return {...step,call:activationCall(step)};
}
export async function activationReceipt(hash:string,step:ActivationStep,scope:ActivationScope):Promise<"unknown"|"mined"|"reverted">{
 assertActivationStep(step,scope,Math.min(Math.floor(Date.now()/1000),step.expiresAt-1));const rpc=createPublicClient({chain:base,transport:chainRpcTransport("base","receipt")});
 try{const [tx,receipt]=await Promise.all([rpc.getTransaction({hash:hash as Hex}),rpc.getTransactionReceipt({hash:hash as Hex})]);
  if(tx.from.toLowerCase()!==scope.owner.toLowerCase()||tx.to?.toLowerCase()!==step.call.to.toLowerCase()||tx.input.toLowerCase()!==step.call.data.toLowerCase()||tx.value!==BigInt(step.call.value))throw new Error("Receipt does not match the reviewed wallet transaction");
  const block=await rpc.getBlock({blockNumber:receipt.blockNumber});if(block.hash!==receipt.blockHash)return "unknown";
  if(receipt.status==="reverted")return "reverted";
  if(tx.to.toLowerCase()===scope.safe.toLowerCase()&&!receipt.logs.some(l=>l.address.toLowerCase()===scope.safe.toLowerCase()&&l.topics[0]===keccak256(toHex("ExecutionSuccess(bytes32,uint256)"))))throw new Error("Safe execution was not confirmed");
  return "mined";
 }catch{return "unknown";}
}
export async function finishActivation(input:Input){
 const now=Math.floor(Date.now()/1000),draft={kind:"session" as const,amount:"0",validUntil:now+86400,expiresAt:now+120,scope:input.scope,policy:input.policy};assertActivationStep({...draft,description:"Verify activation",call:activationCall(draft)},input.scope,now);
 const {account,block}=await read(input);requireActivationReady(account,input.scope.operator,input.policy);
 const {supabaseAdmin}=await import("@/integrations/supabase/client.server");
 const proof={operator:input.scope.operator.toLowerCase(),safe:input.scope.safe,module:input.scope.module,block:block.number.toString(),block_hash:block.hash,observed_at:new Date(Number(block.timestamp)*1000).toISOString()};
 const result=await (supabaseAdmin as any).rpc("activate_synfutures_policy",{p_user_id:input.userId,p_connection_id:input.connectionId,p_policy:input.policy,p_proof:proof});
 if(result.error||result.data!==true)throw new Error("Trading activation was not confirmed; refresh before retrying");
}
