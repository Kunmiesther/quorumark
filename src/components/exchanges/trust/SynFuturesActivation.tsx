import {useEffect,useRef,useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {supabase} from "@/integrations/supabase/client";
import {getTransactionProvider} from "@/lib/wallet/providers";
import {synFuturesActivation,type ActivationResult} from "@/lib/exchanges/synfutures/activation.functions";
import {submitActivation} from "@/lib/exchanges/synfutures/activationWallet";
import type {ActivationPolicy,ActivationStep} from "@/lib/exchanges/synfutures/activation";
type Pending={hash:string|null;step:ActivationStep};
export function SynFuturesActivation({userId,walletId,connectionId,provider,owner,safe,module,live}:{userId:string;walletId:string;connectionId:string;provider:string;owner:string;safe:string;module:string;live:boolean}){
 const client=useQueryClient(),key=`synfutures-activation:${userId}:${connectionId}`;
 const [policy,setPolicy]=useState<ActivationPolicy>({marginUsdc:"125",sessionBudgetUsdc:"125",takeProfitBps:100,lossLimitUsdc:"25",maxDailyEntries:20,acceptMonitoredExits:true});
 const [accepted,setAccepted]=useState(false),[review,setReview]=useState<ActivationResult|null>(null),[pending,setPending]=useState<Pending|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[manualHash,setManualHash]=useState("");
 const current=useRef(0);
 function restorePending(){
  try{const saved=JSON.parse(localStorage.getItem(key)??"null") as Pending|null;setPending(saved);
   if(saved){setReview(null);if(saved.step?.scope.owner.toLowerCase()===owner.toLowerCase()){setPolicy(saved.step.policy);setAccepted(true);}}
  }catch{setReview(null);setMessage("Activation history could not be read. Reconcile wallet activity before signing.");setPending({hash:null,step:null as unknown as ActivationStep});}
 }
 useEffect(()=>{
  current.current++;setReview(null);setMessage("");setAccepted(false);restorePending();
  const storage=(event:StorageEvent)=>{if(event.key===key||event.key===null)restorePending();};
  window.addEventListener("storage",storage);
  window.addEventListener("focus",restorePending);
  window.addEventListener("synfutures-activation-updated",restorePending);
  return()=>{current.current++;window.removeEventListener("storage",storage);window.removeEventListener("focus",restorePending);window.removeEventListener("synfutures-activation-updated",restorePending);};
 },[key,owner,safe,module]);
 const persist=(value:Pending|null)=>{if(value)localStorage.setItem(key,JSON.stringify(value));else localStorage.removeItem(key);setPending(value);window.dispatchEvent(new Event("synfutures-activation-updated"));};
 async function invoke(operation:"plan"|"finish"):Promise<ActivationResult>{const {data}=await supabase.auth.getSession();if(!data.session)throw new Error("Sign in to activate your account");return synFuturesActivation({data:{operation,walletId,policy},headers:{Authorization:`Bearer ${data.session.access_token}`}});}
 const run=async(action:()=>Promise<void>)=>{setBusy(true);setMessage("");try{await action();}catch(e){setMessage(e instanceof Error?e.message:"Activation could not be verified");}finally{setBusy(false);}};
 async function refresh(){setReview(await invoke("plan"));void client.invalidateQueries({queryKey:["synfutures-account-connection",userId,walletId]});}
 async function send(){if(!review?.step||pending)throw new Error("Refresh the review before signing");const version=current.current;const step=review.step;const scope=review.scope;if(scope.owner.toLowerCase()!==owner.toLowerCase()||scope.safe.toLowerCase()!==safe.toLowerCase()||scope.module.toLowerCase()!==module.toLowerCase())throw new Error("Account identity changed");
  if(!navigator.locks)throw new Error("Use a browser supporting secure wallet coordination");
  await navigator.locks.request(`synfutures-owner-actions:${userId}:${connectionId}`,{ifAvailable:true},async lock=>{const recoveryKey=`synfutures-owner-recovery:${[userId,connectionId,owner,safe,module].join(":")}`;if(!lock)throw new Error("Another owner wallet prompt is open. Finish that prompt before continuing.");if(localStorage.getItem(key)){restorePending();throw new Error("A saved wallet transaction needs confirmation. Use Check confirmation and continue below.");}if(localStorage.getItem(recoveryKey))throw new Error("A recovery wallet transaction is pending; confirm it before another owner action using Verify recovery receipt in Native position monitor.");try{const wallet=await getTransactionProvider(provider);const hash=await submitActivation(wallet,step,scope,()=>persist({hash:null,step}),()=>version===current.current);persist({hash,step});setReview(null);setMessage("Submitted. Check confirmation before the next step.");}catch(e){if(e instanceof Error&&e.message==="OWNER_REJECTED")persist(null);throw e;}});
 }
 async function check(){if(!pending?.step)throw new Error("Saved review unavailable. Reconcile wallet activity before continuing");const hash=pending.hash??manualHash;if(!/^0x[0-9a-f]{64}$/i.test(hash))throw new Error("Enter the transaction hash from wallet activity");const {data}=await supabase.auth.getSession();if(!data.session)throw new Error("Sign in to check confirmation");const result=await synFuturesActivation({data:{operation:"receipt",walletId,txHash:hash,step:pending.step},headers:{Authorization:`Bearer ${data.session.access_token}`}});if(result.status==="unknown"){persist({...pending,hash});throw new Error("Transaction remains unconfirmed. It will not be sent again.");}persist(null);setReview(null);if(result.status==="reverted")throw new Error("The transaction reverted. Review a fresh step before retrying.");await refresh();}
 async function finish(){if(pending||review?.status!=="ready")throw new Error("Complete and confirm wallet steps first");const result=await invoke("finish");setReview(result);setMessage("SynFutures live trading activated and verified.");for(const q of ["synfutures-account-connection","exchange-connections","exchange-connections-full","trade-bays-connections","synfutures-native-positions"])void client.invalidateQueries({queryKey:[q]});}
 const locked=busy||!!pending||!!review;
 return <div className="mt-4 rounded-xl border border-cyan-300/20 p-3 text-xs text-white/75">
  <h4 className="font-medium text-cyan-200">SynFutures trading activation</h4>
  <p className="mt-2">{live?"Trading enabled. Renewing setup pauses new entries during verification.":"Complete funding and authorize the dedicated operator on your existing Base account."}</p>
  <div className="mt-3 grid grid-cols-2 gap-2">
   {([['marginUsdc','Campaign margin (USDC)'],['sessionBudgetUsdc','Cumulative session margin (USDC)'],['lossLimitUsdc','Realized loss limit (USDC)']] as const).map(([field,label])=><label key={field}>{label}<input disabled={locked} value={policy[field]} onChange={e=>setPolicy({...policy,[field]:e.target.value})} className="mt-1 w-full rounded bg-black/30 p-2" /></label>)}
   <label>TP price move after all five fills (%)<input disabled={locked} type="number" min="0.01" step="0.01" value={policy.takeProfitBps/100} onChange={e=>setPolicy({...policy,takeProfitBps:Math.round(Number(e.target.value)*100)})} className="mt-1 w-full rounded bg-black/30 p-2" /></label>
   <label>Maximum campaigns per day<input disabled={locked} type="number" min="1" max="100" value={policy.maxDailyEntries} onChange={e=>setPolicy({...policy,maxDailyEntries:Number(e.target.value)})} className="mt-1 w-full rounded bg-black/30 p-2" /></label>
  </div>
  <p className="mt-2">BTC/ETH · 33× · five pullback rungs · one simultaneous campaign · 24-hour session. The session budget is cumulative and must be renewed once used. Operator funding is up to 0.0005 ETH.</p>
  <label className="mt-3 flex gap-2"><input type="checkbox" disabled={locked} checked={accepted} onChange={e=>setAccepted(e.target.checked)} /><span>I accept locally monitored exits: stop 1% beyond the final rung; TP uses the price move above after all five fills. This is the native campaign exit policy. The realized loss limit blocks later entries and does not cap an open trade’s loss.</span></label>
  {!pending&&!review?<button type="button" aria-busy={busy} disabled={busy||!accepted} onClick={()=>void run(refresh)} className="mt-3 rounded bg-cyan-900/60 px-3 py-2 disabled:opacity-40">{busy?"Reviewing funding and activation…":"Review funding and activation"}</button>:null}
  {review?.step&&!pending?<><p className="mt-3 text-cyan-200">{review.step.description}</p><p className="mt-1 break-all">Operator: {review.scope.operator}</p><button disabled={busy} onClick={()=>void run(send)} className="mt-3 rounded bg-cyan-900/60 px-3 py-2">Approve this step in wallet</button><button disabled={busy} onClick={()=>{setReview(null);current.current++;}} className="ml-3 underline">Change review</button></>:null}
  {pending?<><p className="mt-3 text-amber-200">Wallet transaction pending. Further submissions are blocked.</p>{!pending.hash?<input placeholder="Transaction hash from wallet activity" value={manualHash} onChange={e=>setManualHash(e.target.value)} className="mt-2 w-full rounded bg-black/30 p-2" />:<p className="mt-2 break-all">{pending.hash}</p>}<button disabled={busy} onClick={()=>void run(check)} className="mt-3 rounded bg-cyan-900/60 px-3 py-2">Check confirmation and continue</button></>:null}
  {review?.status==="ready"?<><p className="mt-3 text-cyan-200">Funding, markets and operator session are ready.</p><button disabled={busy||!accepted} onClick={()=>void run(finish)} className="mt-3 rounded bg-cyan-900/60 px-3 py-2">Enable and verify live trading</button></>:null}
  {review?.status==="active"?<p className="mt-3 text-cyan-200">Trading active</p>:null}
  {message?<p role="status" className="mt-3 text-amber-200">{message}</p>:null}
 </div>;
}
