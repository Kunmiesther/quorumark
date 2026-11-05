import {keccak256} from "viem";
import {useState,useRef,useEffect} from "react";
import {useQuery} from "@tanstack/react-query";
import {supabase} from "@/integrations/supabase/client";
import {synFuturesLifecycle,type SynLifecycleInput} from "@/lib/exchanges/synfutures/lifecycle.functions";
import {getTransactionProvider} from "@/lib/wallet/providers";
import {submitSynRecovery,type SynRecovery} from "@/lib/exchanges/synfutures/recoveryWallet";
type Pending={phase:SynRecovery["phase"];symbol:SynRecovery["symbol"];hash:string|null;calldata_hash:string};
export function SynFuturesRecovery({userId,connectionId,provider,owner,safe,module}:{userId:string;connectionId:string;provider:string;owner:string;safe:string;module:string}){
 const identity=[userId,connectionId,owner,safe,module].join(":");const current=useRef(identity);current.current=identity;
 const key=`synfutures-owner-recovery:${identity}`;
 const [review,setReview]=useState<SynRecovery|null>(null),[pending,setPending]=useState<Pending|null>(null),[hash,setHash]=useState("");
 const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
 useEffect(()=>{setReview(null);setPending(null);setHash("");setMessage("");try{const raw=localStorage.getItem(key);if(raw){const p=JSON.parse(raw) as Pending;
   if(["enable_module","authorize_owner_exit","close_position"].includes(p.phase)&&["BTC-USDC","ETH-USDC"].includes(p.symbol)&&/^0x[0-9a-f]{64}$/.test(p.calldata_hash)&&(p.hash===null||/^0x[0-9a-fA-F]{64}$/.test(p.hash))){setPending(p);setHash(p.hash??"");}}}catch{setMessage("Recovery history is unreadable. Check your wallet activity before submitting another transaction.");}},[key]);
 const request=async(data:SynLifecycleInput)=>{const {data:auth}=await supabase.auth.getSession();if(!auth.session)throw new Error("Sign in to read this account.");return synFuturesLifecycle({data,headers:{Authorization:`Bearer ${auth.session.access_token}`}});};
 const snapshot=useQuery({queryKey:["synfutures-native-positions",identity],queryFn:()=>request({operation:"positions",connectionId}),retry:false});
 const save=(p:Pending|null)=>{if(p)localStorage.setItem(key,JSON.stringify(p));else localStorage.removeItem(key);setPending(p);setHash(p?.hash??"");};
 const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setMessage("");try{await fn();}catch(e){setMessage(e instanceof Error?e.message:"Recovery unavailable.");}finally{setBusy(false);}};
 const prepare=(symbol:SynRecovery["symbol"])=>run(async()=>{const captured=identity;const result=await request({operation:"owner-recovery",connectionId,symbol,slippage_bps:100});
   if(current.current!==captured)throw new Error("Account changed. Refresh before signing.");if(!result.recovery)throw new Error("Recovery review unavailable.");setReview(result.recovery);});
 const submit=()=>run(async()=>{if(!review||pending)throw new Error("Refresh the recovery review first.");const captured=identity;
   if(!navigator.locks)throw new Error("This browser cannot coordinate safe recovery submissions. Use a current browser.");
   await navigator.locks.request(`synfutures-owner-actions:${userId}:${connectionId}`,{ifAvailable:true},async lock=>{if(!lock)throw new Error("Another owner wallet action is already open.");
    if(localStorage.getItem(`synfutures-activation:${userId}:${connectionId}`))throw new Error("Confirm the pending activation transaction before owner recovery.");
    if(localStorage.getItem(key))throw new Error("Check the pending recovery transaction before submitting again.");
    const wallet=await getTransactionProvider(provider);const intent={phase:review.phase,symbol:review.symbol,hash:null,calldata_hash:keccak256(review.call.data as `0x${string}`)};
    try{const tx=await submitSynRecovery(wallet,review,{owner,safe,module},()=>save(intent),()=>current.current===captured);
     save({...intent,hash:tx});setReview(null);setMessage("Submitted. Verify the receipt before proceeding.");
    }catch(e){if(e instanceof Error&&e.message==="OWNER_REJECTED"){save(null);setMessage("Wallet request rejected; no transaction was sent.");}else throw e;}
   });});
 const check=()=>run(async()=>{if(!pending||!/^0x[0-9a-fA-F]{64}$/.test(hash))throw new Error("Enter the transaction hash from your wallet activity.");
   const captured=identity;const result=await request({operation:"owner-recovery-status",connectionId,symbol:pending.symbol,phase:pending.phase,tx_hash:hash,calldata_hash:pending.calldata_hash});
   if(current.current!==captured)throw new Error("Account changed. Reload its recovery history.");
   if(["mined","confirmed","reverted"].includes(result.status)&&result.reconciliation_required===false){save(null);setReview(null);await snapshot.refetch();
    setMessage(result.status==="reverted"?"Transaction definitively reverted. Refresh the review to retry.":"Recovery step verified. Refresh the position and review the next step if it remains open.");
   }else{save({...pending,hash});setMessage("Receipt remains unconfirmed. Do not submit another recovery transaction.");}});
 const s=snapshot.data?.snapshot;const match=s&&s.owner_address.toLowerCase()===owner.toLowerCase()&&s.safe_address.toLowerCase()===safe.toLowerCase()&&s.module_address.toLowerCase()===module.toLowerCase();
 return <div className="mt-3 space-y-2 border-t border-white/10 pt-3 text-xs text-white/65">
  <h4 className="font-medium text-cyan-200">Native position monitor</h4>
  <button type="button" disabled={busy||snapshot.isFetching} onClick={()=>{setReview(null);void snapshot.refetch();}} className="underline">Refresh native positions</button>
  {snapshot.isPending?<p role="status">Reading your Base account…</p>:null}
  {snapshot.isError?<p role="alert">Position read unavailable; exposure has not been assumed flat.</p>:null}
  {s&&!match?<p role="alert">Account identity changed. Recovery is withheld.</p>:null}
  {match?<><p>Block {s.observed_block} · {new Date(s.timestamp*1000).toLocaleString()}</p>
   <p>{s.operator_exit_available?"On-chain reduction session available":"Operator reductions unavailable; owner recovery is available for open positions."}</p>
   {(["BTC-USDC","ETH-USDC"] as const).map(symbol=><div key={symbol}><span>{symbol}: {s.positions[symbol].signed_size==="0"?"flat":`${s.positions[symbol].signed_size} native size units`}</span>
    {s.positions[symbol].signed_size!=="0"?<button type="button" disabled={busy||!!pending} onClick={()=>prepare(symbol)} className="ml-2 underline">Review owner recovery</button>:null}</div>)}
   <p>Automatic exits are monitored by the bot. They are not resting exchange stops. Wallet recovery requires your approval for each step.</p></>:null}
  {review?<div className="rounded border border-amber-300/30 p-2"><p>{review.phase==="enable_module"?"Enable your registered trading module":review.phase==="authorize_owner_exit"?"Authorize this owner for a five-minute, zero-margin recovery session":"Reduce the reviewed position to zero"} · {review.symbol}</p>
   <p>This recovery can invalidate queued worker trades. No deposit or token approval is included.</p><p className="break-all">To: {review.call.to}</p>
   <button type="button" disabled={busy||!!pending||!match} onClick={submit} className="mt-2 underline">Review and confirm in wallet</button></div>:null}
  {pending?<div><p>Recovery submission pending. Verify its receipt before any further submission.</p><input aria-label="Recovery transaction hash" value={hash} onChange={e=>setHash(e.target.value)} placeholder="0x… from wallet activity" className="w-full rounded bg-black/30 p-2"/>
   <button type="button" disabled={busy} onClick={check} className="underline">Verify recovery receipt</button></div>:null}
  {message?<p role="status" className="text-amber-200">{message}</p>:null}
 </div>;
}
