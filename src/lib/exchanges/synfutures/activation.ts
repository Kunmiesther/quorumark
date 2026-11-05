import {encodeFunctionData,encodePacked,parseAbi,parseUnits,zeroAddress,type Address,type Hex} from "viem";
export const activationContracts={usdc:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",gate:"0x208b443983d8bcc8578e9d86db23fba547071270"} as const;
export type ActivationPolicy={marginUsdc:string;sessionBudgetUsdc:string;takeProfitBps:number;lossLimitUsdc:string;maxDailyEntries:number;acceptMonitoredExits:true};
export type ActivationScope={owner:string;safe:string;module:string;operator:string};
export type ActivationStep={kind:"operator_gas"|"fund_safe"|"approve"|"deposit"|"enable_module"|"market_btc"|"market_eth"|"session";amount:string;validUntil:number;policy:ActivationPolicy;scope:ActivationScope;expiresAt:number;description:string;call:{from:string;to:string;value:Hex;data:Hex}};
export const activationSafeAbi=parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)"]);
const token=parseAbi(["function transfer(address to,uint256 value) returns (bool)","function approve(address spender,uint256 value) returns (bool)"]);
const moduleAbi=parseAbi(["function enableModule(address module)","function configureMarket(address instrument,(uint128 maxPositionSize,uint128 maxPositionNotional,uint128 maxMarginPerTrade,uint16 maxLeverage) limits)","function configureSession(address operator,uint48 validUntil,uint128 marginBudget,uint16 maxSlippageBps)"]);
const gateAbi=parseAbi(["function deposit(bytes32 packedTokenAndAmount)"]);
export const nativeMarkets={"BTC-USDC":"0xec6c44e704eb1932ec5fe1e4aba58db6fee71460","ETH-USDC":"0x04d72fb4803b4e02f14971e5bd092375eb330749"} as const;
export function activationCall(step:Omit<ActivationStep,"call"|"description">):ActivationStep["call"] {
 const s=step.scope;const address=(x:string)=>x as Address;const amount=BigInt(step.amount);let to:string=s.module;let data:Hex="0x";
 if(step.kind==="operator_gas")return {from:s.owner,to:s.operator,value:`0x${amount.toString(16)}`,data:"0x"};
 if(step.kind==="fund_safe")return {from:s.owner,to:activationContracts.usdc,value:"0x0",data:encodeFunctionData({abi:token,functionName:"transfer",args:[address(s.safe),amount]})};
 if(step.kind==="approve"){to=activationContracts.usdc;data=encodeFunctionData({abi:token,functionName:"approve",args:[activationContracts.gate,amount]});}
 else if(step.kind==="deposit"){to=activationContracts.gate;data=encodeFunctionData({abi:gateAbi,functionName:"deposit",args:[`0x${((amount<<160n)|BigInt(activationContracts.usdc)).toString(16).padStart(64,"0")}`]});}
 else if(step.kind==="enable_module"){to=s.safe;data=encodeFunctionData({abi:moduleAbi,functionName:"enableModule",args:[address(s.module)]});}
 else if(step.kind==="market_btc"||step.kind==="market_eth")data=encodeFunctionData({abi:moduleAbi,functionName:"configureMarket",args:[nativeMarkets[step.kind==="market_btc"?"BTC-USDC":"ETH-USDC"],{maxPositionSize:parseUnits(step.kind==="market_btc"?"1":"10",18),maxPositionNotional:parseUnits(step.policy.marginUsdc,18)*33n,maxMarginPerTrade:parseUnits(step.policy.marginUsdc,18)/5n,maxLeverage:33}]});
 else if(step.kind==="session")data=encodeFunctionData({abi:moduleAbi,functionName:"configureSession",args:[address(s.operator),step.validUntil,parseUnits(step.policy.sessionBudgetUsdc,18),50]});
 else throw new Error("Unknown activation step");
 const signature=encodePacked(["bytes32","bytes32","uint8"],[`0x${s.owner.slice(2).padStart(64,"0")}`,`0x${"00".repeat(32)}`,1]);
 return {from:s.owner,to:s.safe,value:"0x0",data:encodeFunctionData({abi:activationSafeAbi,functionName:"execTransaction",args:[address(to),0n,data,0,0n,0n,0n,zeroAddress,zeroAddress,signature]})};
}
export function assertActivationStep(step:ActivationStep,expected:ActivationScope,now=Math.floor(Date.now()/1000)) {
 if(Object.keys(expected).some(k=>step.scope[k as keyof ActivationScope].toLowerCase()!==expected[k as keyof ActivationScope].toLowerCase())||step.expiresAt<=now||step.expiresAt>now+120)throw new Error("Activation review expired or account changed");
 const margin=parseUnits(step.policy.marginUsdc,6),budget=parseUnits(step.policy.sessionBudgetUsdc,6),loss=parseUnits(step.policy.lossLimitUsdc,6);
 if(margin<=0n||margin>125_000_000n||margin%5n!==0n||budget<margin||budget>1_250_000_000n||loss<=0n||loss>margin||!step.policy.acceptMonitoredExits||!Number.isInteger(step.policy.takeProfitBps)||step.policy.takeProfitBps<1||step.policy.takeProfitBps>9999||!Number.isInteger(step.policy.maxDailyEntries)||step.policy.maxDailyEntries<1||step.policy.maxDailyEntries>100)throw new Error("Invalid activation limits");
 const amount=BigInt(step.amount);if(amount<0n||(step.kind==="operator_gas"&&(amount<=0n||amount>500_000_000_000_000n))||(["fund_safe","approve","deposit"].includes(step.kind)&&(amount<=0n||amount>margin))||(step.kind==="session"&&(step.validUntil<=now+600||step.validUntil>now+86400)))throw new Error("Activation amount or expiry exceeds review");
 const expectedCall=activationCall(step);if(JSON.stringify(expectedCall)!==JSON.stringify(step.call))throw new Error("Activation calldata does not match the reviewed step");
}
export function requireActivationReady(account:any,operator:string,policy:ActivationPolicy,now=Math.floor(Date.now()/1000)) {
 if(!account?.permissions?.module_enabled||account.permissions.operator?.toLowerCase()!==operator.toLowerCase()||account.permissions.valid_until<=now+600||parseUnits(account.permissions.margin_budget_usdc,18)-parseUnits(account.permissions.margin_spent_usdc,18)<parseUnits(policy.marginUsdc,18)||BigInt(account.operator_gas_wei??"0")<300_000_000_000_000n||parseUnits(account.balances?.gate_reserve_usdc??"0",6)<parseUnits(policy.marginUsdc,6))throw new Error("Funding and operator session are not yet ready");
 if(!account.positions||account.positions.some((p:any)=>p.has_exposure)||!account.markets||account.markets.length!==2||account.markets.some((m:any)=>!m.entries_enabled||m.max_leverage!==33||parseUnits(m.max_margin_per_trade_usdc,18)<parseUnits(policy.marginUsdc,18)/5n||parseUnits(m.max_notional_usdc,18)<parseUnits(policy.marginUsdc,18)*33n))throw new Error("Market limits or existing positions block activation");
}
