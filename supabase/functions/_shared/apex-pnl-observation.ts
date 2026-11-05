// Preserve venue-reported history for otherwise ambiguous FIFO attribution.
// Deliberately NOT a settlement: fee/funding semantics and exact position
// coverage must be established before changing accounting or risk admission.
export async function observeApexClosedPnl(db: any, conn: {id:string;user_id:string},
  read:(opts:{symbol:string;begin:number;end:number})=>Promise<{ok:boolean;rows?:Record<string,unknown>[];reason?:string}>) {
  const rows=await db.from('positions').select('id,pair,opened_at,updated_at')
    .eq('user_id',conn.user_id).eq('connection_id',conn.id).eq('exchange','apex_omni')
    .eq('source','live').eq('status','closed').is('pnl_amount',null)
    .order('updated_at',{ascending:false}).limit(100);
  if(rows.error || !Array.isArray(rows.data)) return {status:'failed'};
  const prior=await db.from('apex_closed_pnl_observations').select('position_id,observed_at')
    .eq('user_id',conn.user_id).eq('connection_id',conn.id);
  if(prior.error || !Array.isArray(prior.data)) return {status:'failed'};
  const recent=new Set(prior.data.filter((r:any)=>Date.parse(r.observed_at)>Date.now()-86400_000).map((r:any)=>r.position_id));
  const selected=rows.data.filter((r:any)=>!recent.has(r.id)).slice(0,2);
  let observed=0,failed=0;
  await Promise.all(selected.map(async(p:any)=>{
    const begin=Date.parse(p.opened_at)-300_000,end=Date.parse(p.updated_at)+60_000;
    if(!Number.isFinite(begin)||!Number.isFinite(end)||begin>=end){failed++;return;}
    try {
      const result=await read({symbol:p.pair,begin,end});
      const keys=['symbol','size','totalPnl','price','exitPrice','createdAt','type','isLiquidate','isDeleverage'];
      const evidence={status:result.ok?'observed':'unavailable',symbol:p.pair,begin,end,
        rows:result.ok?(result.rows??[]).map(r=>Object.fromEntries(keys.filter(k=>r[k]!==undefined).map(k=>[k,r[k]]))):[]};
      const saved=await db.from('apex_closed_pnl_observations').upsert({position_id:p.id,user_id:conn.user_id,
        connection_id:conn.id,observed_at:new Date().toISOString(),evidence},{onConflict:'position_id'});
      if(saved.error) failed++;else observed++;
    } catch {failed++;}
  }));
  return {status:failed?'partial':'checked',observed,failed};
}
