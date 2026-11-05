"""Private native campaign executor. Worker/browser never select a signing key.

Only locally verified snapshots, owned configuration, durable campaign leases
and exact canonical journals grant dispatch. Default deployment is disarmed.
"""
import json
import os
import time
import uuid
from eth_account import Account
from .synfutures_entry import require, plan_entry, SynFuturesEntryError
from .synfutures_positions import read_positions, contract_call, limit_tick
from .synfutures_submission import submit_module_transaction, SubmissionLimits, SynFuturesSubmissionError
from .synfutures_reconciliation import observe_transaction, quantity
from .synfutures_campaign import build_campaign, next_action, SESSION_EXIT_BUFFER
from . import synfutures_account as native
from shared.synfutures_math import WAD, wad_decimal, price_at_tick, tick_at_price, decimal_wad


def entry_enabled():
    return os.environ.get('SYNFUTURES_SIGNER_AUTOMATION_ENABLED','').lower()=='true'


def operator_account(*, user_id, connection_id, snapshot):
    try:
        bindings=json.loads(os.environ.get('TURTLEBOT_SYNFUTURES_OPERATOR_BINDINGS','{}'))
        binding=bindings[connection_id]
        require(binding['user_id']==user_id, 'SYNFUTURES_OPERATOR_SCOPE_MISMATCH')
        account=Account.from_key(binding['private_key'])
        gas=binding['gas_limits']
        limits=SubmissionLimits(gas['max_gas'],gas['max_fee_per_gas'],gas['max_total_gas_cost'])
        limits.validate()
    except (SynFuturesEntryError,SynFuturesSubmissionError):raise
    except Exception:raise SynFuturesEntryError('SYNFUTURES_OPERATOR_CONFIGURATION_REQUIRED') from None
    require(account.address.lower()==snapshot['operator_address'], 'SYNFUTURES_OPERATOR_MISMATCH')
    return account,limits


def strategy_configuration(context,symbol):
    rows=[s for s in context['strategies'] if s.get('symbol')==symbol and s.get('mode')=='live' and s.get('enabled') is True]
    require(len(rows)==1 and isinstance(rows[0].get('params'),dict), 'SYNFUTURES_CAMPAIGN_CONFIGURATION_REQUIRED')
    return rows[0]['params']


def native_quote(*, rpc, snapshot, symbol, margin, leverage, long, managed_size=None):
    at={'blockHash':snapshot['block_hash'],'requireCanonical':True}
    instrument=native.MARKETS[symbol]; p=snapshot['positions'][symbol]
    call=lambda addr,sig,types=(),args=(),outputs=():contract_call(rpc,at,addr,sig,types,args,outputs)
    limits=call(snapshot['module_address'],'marketLimits(address)',['address'],[instrument],['uint128','uint128','uint128','uint16'])
    setting=call(native.OBSERVER,'getSetting(address)',['address'],[instrument],[native.SETTING])[0]
    require(0<setting[6]<=10_000,'SYNFUTURES_MARGIN_RATIO_UNCONFIRMED')
    existing_notional=int(p['entry_notional']); existing_balance=int(p['balance'])
    def quote(value):
        require(value>0,'SYNFUTURES_FEE_ADJUSTED_LEVERAGE_LIMIT')
        size,q=call(native.OBSERVER,'inquireByNotional(address,uint32,uint256,bool)',
            ['address','uint32','uint256','bool'],[instrument,2**32-1,value,long],['int256',native.QUOTE])
        return {'size':size,'mark':q[3],'entry_notional':q[4],'fee':q[5],'min_amount':q[6]}
    q=quote(margin*leverage)
    capacity=min((existing_balance+margin-q['fee'])*leverage-existing_notional,
                 (existing_balance+margin-q['fee'])*10_000//setting[6]-existing_notional)
    if q['entry_notional']>capacity:q=quote(capacity)
    portfolio=sum(max(int(x['entry_notional']),abs(int(x['signed_size']))*int(x['mark'])//WAD) for x in snapshot['positions'].values())
    account={'available_margin':int(snapshot['reserve']),'budget_remaining':int(snapshot['margin_budget'])-int(snapshot['margin_spent']),
        'max_size':limits[0],'max_notional':limits[1],'max_margin':limits[2],'max_leverage':limits[3],
        'minimum_margin':setting[8][0],'initial_margin_ratio':setting[6], 'portfolio_notional':portfolio,
        'portfolio_limit':int(snapshot['margin_budget'])*leverage,'slippage_bps':snapshot['slippage_bps'],
        'position_size':int(p['signed_size']),'position_balance':existing_balance,'position_notional':existing_notional}
    return plan_entry(margin_usdc=wad_decimal(margin),leverage=leverage,long=long,quote=q,account=account,managed_size=managed_size)


def reconcile_native(*, db, rpc, user_id, connection_id):
    rows=db.list_synfutures_transactions(user_id=user_id,connection_id=connection_id)
    require(isinstance(rows,list) and len(rows)<=20,'SYNFUTURES_JOURNAL_UNAVAILABLE')
    for row in rows:
        require(row.get('user_id')==user_id and row.get('connection_id')==connection_id,'SYNFUTURES_JOURNAL_SCOPE_MISMATCH')
        try: observation=observe_transaction(row,rpc,include_provisional=True)
        except Exception: observation={'state':'unknown'}
        if observation['state']=='mined':
            db.synfutures_campaign_operation(operation='SYNFUTURES_PROVISIONAL_RECORD',user_id=user_id,connection_id=connection_id,
                intent_id=row['intent_id'],tx_hash=row['tx_hash'],block=observation['block'],block_hash=observation['block_hash'])
        else:
            db.synfutures_campaign_operation(operation='SYNFUTURES_PROVISIONAL_RECORD',user_id=user_id,connection_id=connection_id,
                intent_id=row['intent_id'],tx_hash=row['tx_hash'],block=None,block_hash=None)
            db.observe_synfutures_transaction(user_id=user_id,connection_id=connection_id,intent_id=row['intent_id'],tx_hash=row['tx_hash'],**observation)


def prepare_campaign(*, db, rpc, user_id, connection_id, symbol, margin_usdc, leverage, long, campaign_key):
    require(entry_enabled(),'SYNFUTURES_AUTOMATION_DISABLED')
    require(isinstance(campaign_key,str) and 8<=len(campaign_key)<=64,'SYNFUTURES_CAMPAIGN_INVALID')
    context=db.synfutures_campaign_operation(operation='SYNFUTURES_CAMPAIGN_CONTEXT',user_id=user_id,connection_id=connection_id)
    config=strategy_configuration(context,symbol)
    require(config.get('native_locally_monitored_exits_accepted') is True,
            'SYNFUTURES_MONITORED_EXIT_ACCEPTANCE_REQUIRED')
    require(config.get('margin_usdc')==margin_usdc and config.get('leverage')==leverage,'SYNFUTURES_CAMPAIGN_CONFIGURATION_MISMATCH')
    existing=[c for c in context['campaigns'] if c['campaign_key']==campaign_key]
    if existing:
        require(existing[0]['symbol']==symbol and (existing[0]['side']=='BUY')==long
                and existing[0]['plan']['margin_total']==str(decimal_wad(margin_usdc)) and existing[0]['plan']['leverage']==leverage,'SYNFUTURES_CAMPAIGN_REPLAY_MISMATCH')
        return {'status':'duplicate','campaign_rung_count':5,'exchange_status':existing[0]['status']}
    require(context.get('monitor_recent') is True,'SYNFUTURES_MONITOR_REQUIRED')
    snapshot=read_positions(db=db,rpc=rpc,user_id=user_id,connection_id=connection_id)
    require(snapshot['live_entry_allowed'] and db.is_execution_halted(user_id,connection_id,require_live=True) is False,
            'SYNFUTURES_LIVE_PERMISSION_REQUIRED')
    require(snapshot['operator_exit_available'] and snapshot['session_valid_until']>snapshot['timestamp']+2*SESSION_EXIT_BUFFER,
            'SYNFUTURES_PROTECTIVE_EXIT_REQUIRED')
    require(not db.list_synfutures_transactions(user_id=user_id,connection_id=connection_id),'SYNFUTURES_TRANSACTION_IN_FLIGHT')
    require(int(snapshot['positions'][symbol]['signed_size'])==0,'SYNFUTURES_EXISTING_EXPOSURE')
    account,limits=operator_account(user_id=user_id,connection_id=connection_id,snapshot=snapshot)
    require(quantity(rpc('eth_getBalance',[account.address,'pending']))>=2*limits.max_total_gas_cost,'SYNFUTURES_EXIT_GAS_RESERVE_REQUIRED')
    plan=build_campaign(symbol=symbol,long=long,margin_usdc=margin_usdc,leverage=leverage,
        reference_mark=int(snapshot['positions'][symbol]['mark']),take_profit_bps=config.get('native_take_profit_bps'),
        starting_balance=int(snapshot['positions'][symbol]['balance']),start_block=int(snapshot['observed_block']))
    require(int(plan['margin_total'])<=min(int(snapshot['reserve']),int(snapshot['margin_budget'])-int(snapshot['margin_spent'])),
            'SYNFUTURES_MARGIN_ABOVE_LIMIT')
    quote=native_quote(rpc=rpc,snapshot=snapshot,symbol=symbol,margin=int(plan['margin_per_rung']),leverage=leverage,long=long)
    result=db.synfutures_campaign_operation(operation='SYNFUTURES_CAMPAIGN_CREATE',user_id=user_id,connection_id=connection_id,
        campaign_key=campaign_key,plan=plan,module_revision=snapshot['module_revision'],size=wad_decimal(abs(int(quote['signed_size']))))
    require(isinstance(result,dict) and isinstance(result.get('id'),str),'SYNFUTURES_CAMPAIGN_RESERVATION_UNCONFIRMED')
    # No first entry is broadcast here. The monitor observes the adverse move.
    return {'status':'submitted' if result['created'] else 'duplicate','campaign_rung_count':5,'exchange_status':'waiting_for_pullback' if result['created'] else result['status']}


def dispatch_action(*, db, rpc, snapshot, campaign, token, action, user_id, connection_id):
    account,limits=operator_account(user_id=user_id,connection_id=connection_id,snapshot=snapshot)
    require(snapshot['operator_exit_available'],'SYNFUTURES_OPERATOR_EXIT_UNAVAILABLE')
    p=snapshot['positions'][campaign['symbol']]; reduce=action['kind']=='exit'
    if reduce:
        size=-int(p['signed_size']); require(size!=0,'SYNFUTURES_RECOVERY_NO_POSITION')
        require(not any(a.get('kind')=='exit' and a.get('state') not in ('failed','reverted') for a in campaign['actions']),'SYNFUTURES_EXIT_ALREADY_DISPATCHED')
        tick=limit_tick(int(p['mark']),size>0,snapshot['slippage_bps']); margin=0
    else:
        require(entry_enabled() and snapshot['live_entry_allowed'],'SYNFUTURES_AUTOMATION_DISABLED')
        require(snapshot['session_valid_until']>snapshot['timestamp']+2*SESSION_EXIT_BUFFER,'SYNFUTURES_PROTECTIVE_EXIT_REQUIRED')
        require(quantity(rpc('eth_getBalance',[account.address,'pending']))>=2*limits.max_total_gas_cost,'SYNFUTURES_EXIT_GAS_RESERVE_REQUIRED')
        require(db.is_execution_halted(user_id,connection_id,require_live=True) is False,'SYNFUTURES_EXECUTION_HALTED')
        current=db.synfutures_campaign_operation(operation='SYNFUTURES_CAMPAIGN_CONTEXT',user_id=user_id,connection_id=connection_id)
        config=strategy_configuration(current,campaign['symbol'])
        require(config.get('native_locally_monitored_exits_accepted') is True
            and config.get('autopilot_workflow_id')==campaign['autopilot_workflow_id']
            and str(decimal_wad(config.get('margin_usdc')))==campaign['plan']['margin_total']
            and config.get('leverage')==campaign['plan']['leverage']
            and config.get('native_take_profit_bps')==campaign['plan']['take_profit_bps'], 'SYNFUTURES_CAMPAIGN_CONFIGURATION_MISMATCH')
        margin=int(campaign['plan']['margin_per_rung'])
        expected=sum(int(a['signed_size']) for a in campaign['actions'] if a['state']=='confirmed')
        quote=native_quote(rpc=rpc,snapshot=snapshot,symbol=campaign['symbol'],margin=margin,
            leverage=campaign['plan']['leverage'],long=campaign['side']=='BUY',managed_size=expected)
        size=int(quote['signed_size']); tick=quote['limit_tick']
        trigger=int(campaign['plan']['triggers'][action['rung']-1])
        target=tick_at_price(trigger)
        if size<0 and price_at_tick(target)<trigger:target+=1
        tick=min(tick,target) if size>0 else max(tick,target)
    require(int(time.time())-snapshot['timestamp']<=30,'SYNFUTURES_BLOCK_STALE')
    prepared=db.synfutures_campaign_operation(operation='SYNFUTURES_ACTION_PREPARE',user_id=user_id,connection_id=connection_id,
        campaign_id=campaign['id'],token=token,kind=action['kind'],rung=0 if reduce else action['rung'],
        size=wad_decimal(abs(size)),reason=action['reason'])
    row={'user_id':user_id,'connection_id':connection_id,'intent_id':prepared['intent_id'],'chain_id':8453,
        'operator_address':snapshot['operator_address'],'safe_address':snapshot['safe_address'],'module_address':snapshot['module_address'],
        'instrument_address':native.MARKETS[campaign['symbol']], 'operator_nonce':str(quantity(rpc('eth_getTransactionCount',[account.address,'pending']))),
        'module_revision':snapshot['module_revision'],'module_nonce':snapshot['module_nonce'],'signed_size':str(size),'margin':str(margin),'reduce_only':reduce}
    deadline=min(snapshot['timestamp']+120,snapshot['session_valid_until'])
    # Account verification and coverage derive here, from the fresh owned read,
    # protected durable campaign and its exclusive lease, never request flags.
    try:
        return submit_module_transaction(db=db,rpc=rpc,account=account,row=row,limit_tick=tick,deadline=deadline,
        session_valid_until=snapshot['session_valid_until'],limits=limits,verified_account=True,protective_exit_ready=True)
    except SynFuturesSubmissionError as exc:
        # A reservation timeout remains ambiguous. Every other submission
        # exception precedes reservation/broadcast; still prove no journal in DB.
        if str(exc)!='SYNFUTURES_RESERVATION_UNCONFIRMED':
            db.synfutures_campaign_operation(operation='SYNFUTURES_ACTION_FAIL',user_id=user_id,connection_id=connection_id,
                campaign_id=campaign['id'],token=token,intent_id=prepared['intent_id'])
        raise


def monitor_connection(*, db, rpc, user_id, connection_id, entries_paused=False):
    reconcile_native(db=db,rpc=rpc,user_id=user_id,connection_id=connection_id)
    snapshot=read_positions(db=db,rpc=rpc,user_id=user_id,connection_id=connection_id)
    context=db.synfutures_campaign_operation(operation='SYNFUTURES_CAMPAIGN_CONTEXT',user_id=user_id,connection_id=connection_id)
    halted=entries_paused or not entry_enabled() or not snapshot['live_entry_allowed'] or db.is_execution_halted(user_id,connection_id,require_live=True)
    decisions=[]
    for campaign in context['campaigns']:
        token=str(uuid.uuid4())
        claim=db.synfutures_campaign_operation(operation='SYNFUTURES_CAMPAIGN_CLAIM',user_id=user_id,connection_id=connection_id,campaign_id=campaign['id'],token=token)
        if claim is not True:continue
        # Claim fences abandoned preparation before reading current history.
        refreshed=db.synfutures_campaign_operation(operation='SYNFUTURES_CAMPAIGN_CONTEXT',user_id=user_id,connection_id=connection_id)
        campaign=next(c for c in refreshed['campaigns'] if c['id']==campaign['id'])
        action=next_action(campaign=campaign,actions=campaign['actions'],snapshot=snapshot,entry_halted=halted)
        status=campaign['status']
        attempted=action['kind'] in ('entry','exit')
        try:
            if action['kind'] in ('entry','exit'):
                dispatch_action(db=db,rpc=rpc,snapshot=snapshot,campaign=campaign,token=token,action=action,user_id=user_id,connection_id=connection_id)
                status='closing' if action['kind']=='exit' else 'active'
            elif action['kind']=='close':
                from .synfutures_settlement import settlement
                proof=settlement(campaign=campaign,snapshot=snapshot,rpc=rpc)
                db.synfutures_campaign_operation(operation='SYNFUTURES_CAMPAIGN_SETTLE',user_id=user_id,connection_id=connection_id,
                    campaign_id=campaign['id'],token=token,proof=proof)
                status='closed'
            elif action['kind'] in ('cancel','recovery'):
                status={'cancel':'cancelled','close':'closed','recovery':'recovery_required'}[action['kind']]
        except (SynFuturesEntryError,SynFuturesSubmissionError) as e:
            status='recovery_required'; action={'kind':'recovery','reason':str(e)}
        finally:
            # A failed write cannot claim coverage or unlock an unresolved tx.
            db.synfutures_campaign_operation(operation='SYNFUTURES_CAMPAIGN_FINISH',user_id=user_id,connection_id=connection_id,
                campaign_id=campaign['id'],token=token,status=status,reason=action['reason'])
        decisions.append({'symbol':campaign['symbol'],'kind':action['kind'],'reason':action['reason']})
        # Account/module nonce changed after any dispatch; never reuse snapshot
        # to submit a second market in the same pass.
        if attempted:break
    db.synfutures_campaign_operation(operation='SYNFUTURES_MONITOR_WRITE',user_id=user_id,connection_id=connection_id,
        snapshot={**snapshot,'decisions':decisions,'protection_type':'locally_monitored','entries_enabled':entry_enabled()})
    return {'status':'monitored','reconciliation_required':any(x['kind']=='recovery' for x in decisions),
        'resolved_campaign_keys':context.get('resolved_campaign_keys',[])}
