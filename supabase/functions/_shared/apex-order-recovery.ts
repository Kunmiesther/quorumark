// Bounded recovery by exact client ID; venue GETs only. SQL independently
// validates identity/quantities and atomically preserves the prior row.
type Db = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => PromiseLike<any> };
type Conn = { id: string; user_id: string; exchange: string; environment?: string | null };
function normalizedSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const symbol=value.trim().toUpperCase().replace(/[-/_\s]/g,'');
  return /^[A-Z0-9]+$/.test(symbol)?symbol:null;
}
function symbolIsAbsent(symbol: unknown, rows: Array<{symbol?: string}>): boolean {
  const key=normalizedSymbol(symbol);
  // Unreadable identities cannot prove an empty symbol book.
  return key!==null && rows.every(row=>{
    const other=normalizedSymbol(row.symbol);
    return other!==null && other!==key;
  });
}
/** Exact parity with signer/app/client_order_id.py; never query the internal key. */
export async function apexVenueClientId(raw: string): Promise<string> {
  const cleaned=raw.replace(/[^A-Za-z0-9]/g,'');
  if(cleaned===raw && cleaned.length<=32) return cleaned;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))))
    .map(n=>n.toString(16).padStart(2,'0')).join('').slice(0,24);
  return ((cleaned.slice(0,8)||'tb')+digest).slice(0,32);
}
export function apexOrderEvidence(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (!(r.id || r.orderId) || !(r.clientOrderId || r.clientId)) return null;
  if(r.clientOrderId && r.clientId && r.clientOrderId!==r.clientId) return null;
  return { id: String(r.id || r.orderId), client_order_id: r.clientOrderId || r.clientId,
    symbol: r.symbol, side: r.side, order_type: r.type, size: r.size,
    // Matched but not settled fills are not sufficient evidence.
    filled_size: r.cumSuccessFillSize, status: r.status,
    reduce_only: r.reduceOnly };
}
export function findExactApexOrder(rows: unknown[], clientId: string): unknown | null {
  const matches=rows.filter(row=>apexOrderEvidence(row)?.client_order_id===clientId);
  return matches.length===1?matches[0]:null;
}
export async function recoverApexOrders(db: Db, conn: Conn, snapshot: {
  positions: Array<{ symbol: string }>; orders: Array<{ symbol?: string }>;
}, read: (clientId: string, context: {symbol:string;createdAt:string}) => Promise<{ ok: boolean; data?: unknown; reason?: string; source?:string }>) {
  const snapshotAt=new Date().toISOString();
  if (conn.exchange !== 'apex_omni' || !['mainnet','production','prod','live'].includes(String(conn.environment||'mainnet').toLowerCase().trim())) return { status: 'not_applicable' };
  const { data, error } = await db.from('order_intents')
    .select('id,client_order_id,symbol,created_at').eq('user_id', conn.user_id)
    .eq('connection_id', conn.id).eq('venue','apex_omni').eq('environment','mainnet')
    .eq('state','reconciliation_required')
    .or(`last_reconciled_at.is.null,last_reconciled_at.lt.${new Date(Date.now()-15*60_000).toISOString()}`)
    .order('last_reconciled_at', { ascending:true, nullsFirst:true }).order('created_at',{ascending:true}).limit(8);
  if (error || !Array.isArray(data)) return { status:'failed', reason:'APEX_RECOVERY_LEDGER_READ_FAILED' };
  let resolved=0, unresolved=0, failed=0;
  // Two concurrent reads, at most eight attempts per cycle; no venue writes.
  for (let offset=0;offset<data.length;offset+=2) await Promise.all(data.slice(offset,offset+2).map(async intent => {
    try {
      const result=await read(await apexVenueClientId(intent.client_order_id),{symbol:intent.symbol,createdAt:intent.created_at});
      const raw=result.data && typeof result.data==='object' ? result.data as Record<string,unknown> : {};
      const evidence={ observed_at:snapshotAt,
        symbol_flat:symbolIsAbsent(intent.symbol,snapshot.positions),
        symbol_orders_empty:symbolIsAbsent(intent.symbol,snapshot.orders),
        order:result.ok?apexOrderEvidence(result.data):null,
        response_keys:result.data && typeof result.data==='object'
          ? Object.keys(result.data).slice(0,20).map(k=>k.replace(/[^A-Za-z0-9_]/g,'').slice(0,40)):[],
        response_identity:Object.fromEntries(['id','clientId','clientOrderId','symbol','status','cumSuccessFillSize']
          .filter(k=>typeof raw[k]==='string'||typeof raw[k]==='number'||raw[k]===null)
          .map(k=>[k,typeof raw[k]==='string'?(raw[k] as string).slice(0,128):raw[k]])),
        read_source:result.source??'exact_client_id',
        read_status:result.ok?'observed':'unavailable' };
      const saved=await db.rpc('reconcile_apex_order_evidence',{
        p_user_id:conn.user_id,p_connection_id:conn.id,p_intent_id:intent.id,p_evidence:evidence });
      if(saved.error) {
        // Invalid venue fields cannot clear the guard, but also must not
        // monopolize the oldest-first queue forever.
        const rotated=await db.rpc('reconcile_apex_order_evidence',{
          p_user_id:conn.user_id,p_connection_id:conn.id,p_intent_id:intent.id,
          p_evidence:{...evidence,unverified_order:evidence.order,order:null,read_status:'evidence_unverified'} });
        if(rotated.error) failed++; else unresolved++;
      } else if(saved.data==='RESOLVED') resolved++; else unresolved++;
    } catch { failed++; }
  }));
  return {status:failed?'partial':'checked',observed:data.length,resolved,unresolved,failed};
}
