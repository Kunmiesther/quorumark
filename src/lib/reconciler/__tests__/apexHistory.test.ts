// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readApexPages } from '../../../../supabase/functions/_shared/apex-history-pages';
import { apexOrderEvidence, apexVenueClientId, recoverApexOrders, findExactApexOrder } from '../../../../supabase/functions/_shared/apex-order-recovery';

describe('ApeX complete history boundary',()=>{
  it('reads beyond page zero before returning success',async()=>{
    const read=vi.fn(async(page:number)=>({ok:true,data:{fills:page===0?[1,2]:[3],totalSize:3}}));
    expect(await readApexPages({read,keys:['fills'],pageSize:2})).toEqual({ok:true,rows:[1,2,3]});
    expect(read.mock.calls.map(c=>c[0])).toEqual([0,1]);
  });
  it.each([
    [{ok:true,data:{}},'APEX_HISTORY_SHAPE_INVALID'],
    [{ok:true,data:{fills:[],totalSize:2}},'APEX_HISTORY_INCOMPLETE'],
    [{ok:false,reason:'APEX_TIMEOUT'},'APEX_TIMEOUT'],
  ])('does not return partial success for bad evidence',async(response,reason)=>{
    expect(await readApexPages({read:async()=>response as any,keys:['fills'],pageSize:2})).toEqual({ok:false,reason});
  });
  it('does not advance a cursor after a second-page failure',async()=>{
    expect(await readApexPages({read:async p=>p?{ok:false,reason:'timeout'}:{ok:true,data:[1,2]},keys:[],pageSize:2}))
      .toEqual({ok:false,reason:'timeout'});
  });
  it('refuses a changing total and an endless full-page history',async()=>{
    expect(await readApexPages({read:async p=>({ok:true,data:{fills:[1,2],totalSize:p?6:4}}),keys:['fills'],pageSize:2}))
      .toEqual({ok:false,reason:'APEX_HISTORY_TOTAL_CHANGED'});
    expect(await readApexPages({read:async()=>({ok:true,data:[1,2]}),keys:[],pageSize:2,maxPages:2}))
      .toEqual({ok:false,reason:'APEX_HISTORY_PAGE_LIMIT'});
  });
  it('handles empty and exact-full final pages',async()=>{
    expect(await readApexPages({read:async()=>({ok:true,data:[]}),keys:[],pageSize:2})).toEqual({ok:true,rows:[]});
    expect(await readApexPages({read:async()=>({ok:true,data:{fills:[1,2],totalSize:2}}),keys:['fills'],pageSize:2}))
      .toEqual({ok:true,rows:[1,2]});
  });
});
describe('ApeX bounded evidence',()=>{
  it('accepts only a unique exact client identity from history',()=>{
    const row={id:'venue',clientOrderId:'wanted'};
    expect(findExactApexOrder([row,{id:'other',clientId:'different'}],'wanted')).toEqual(row);
    expect(findExactApexOrder([{},null,{id:'',clientId:'wanted'}],'wanted')).toBeNull();
    expect(findExactApexOrder([row,row],'wanted')).toBeNull();
    expect(findExactApexOrder([{id:'venue',clientId:'wanted',clientOrderId:'conflict'}],'wanted')).toBeNull();
  });
  it.each(['btc-usdt','BTCUSDT','btc/usdt','BTC_USDT','',undefined,'?'])('cannot prove flat or empty with matching/unreadable symbol %s',async symbol=>{
    const query:any={};for(const method of ['select','eq','or','order']) query[method]=vi.fn(()=>query);
    query.limit=vi.fn(async()=>({data:[{id:'i',client_order_id:'plain123',symbol:'BTC-USDT'}],error:null}));
    const rpc=vi.fn(async(_name:string,_args:Record<string,unknown>)=>({data:'UNRESOLVED',error:null}));
    await recoverApexOrders({from:()=>query,rpc},{id:'c',user_id:'u',exchange:'apex_omni'},
      {positions:[{symbol:symbol as string}],orders:[{symbol}]},async()=>({ok:false}));
    expect(rpc.mock.calls[0][1]).toMatchObject({p_evidence:{symbol_flat:false,symbol_orders_empty:false}});
  });
  it.each(['mainnet','production','prod','live'])("recovers canonical mainnet intents for %s connections",async environment=>{
    const query:any={};for(const method of ['select','eq','or','order']) query[method]=vi.fn(()=>query);
    query.limit=vi.fn(async()=>({data:[{id:'i',client_order_id:'plain123',symbol:'BTC-USDT'}],error:null}));
    const rpc=vi.fn(async(_name:string,_args:Record<string,unknown>)=>({data:'UNRESOLVED',error:null}));const read=vi.fn(async()=>({ok:false}));
    const result=await recoverApexOrders({from:()=>query,rpc},{id:'c',user_id:'u',exchange:'apex_omni',environment},
      {positions:[],orders:[]},read);
    expect(result).toMatchObject({status:'checked',unresolved:1});
    expect(read).toHaveBeenCalledWith('plain123',{symbol:'BTC-USDT',createdAt:undefined});
    expect(query.eq).toHaveBeenCalledWith('environment','mainnet');
    expect(rpc.mock.calls[0][1]).toMatchObject({p_user_id:'u',p_connection_id:'c',p_evidence:{order:null}});
  });
  it('matches the signer client-ID transformation exactly',async()=>{
    expect(await apexVenueClientId('plain123')).toBe('plain123');
    expect(await apexVenueClientId('tb1:e3ab35768a4bfabb991019929f2bdcca4a1b83693a5052f992b3da544408-r1'))
      .toBe('tb1e3ab309f23705d59c4b71c8da9c2f');
  });
  it('never turns missing order data into a cancellation',()=>{
    for(const input of [null,{},[],{code:1001},{id:'v'}]) expect(apexOrderEvidence(input)).toBeNull();
  });
  it('retains settled quantity without storing credentials or arbitrary payload fields',()=>{
    const result=apexOrderEvidence({id:'v',clientOrderId:'c',cumSuccessFillSize:'0.1',cumMatchFillSize:'0.2',secret:'hidden'});
    expect(result?.filled_size).toBe('0.1');
    expect(result).not.toHaveProperty('secret');
    expect(apexOrderEvidence({id:'v',clientOrderId:'',clientId:'actual'})).toMatchObject({client_order_id:'actual'});
    expect(apexOrderEvidence({id:'v',clientOrderId:'other',clientId:'actual'})).toBeNull();
  });
});
