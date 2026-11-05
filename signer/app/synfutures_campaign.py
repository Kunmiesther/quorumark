"""Exact five-rung campaign decisions. Native triggers are locally monitored.

No floats, default margin, implicit TP, or acceptance-as-fill. This module is
pure: the durable lease, verified account, journal and submission adapter must
authorize every action. The deployed module provides no resting native stop.
"""
from shared.synfutures_math import WAD, decimal_wad
from shared.parity_constants import get_decimal
from .synfutures_entry import require

VERSION = 1
SESSION_EXIT_BUFFER = 300


def build_campaign(*, symbol, long, margin_usdc, leverage, reference_mark, take_profit_bps, starting_balance=0, start_block=0):
    require(symbol in ('BTC-USDC','ETH-USDC') and type(long) is bool, 'SYNFUTURES_CAMPAIGN_INVALID')
    require(type(leverage) is int and 1 <= leverage <= 33, 'SYNFUTURES_LEVERAGE_ABOVE_LIMIT')
    require(type(reference_mark) is int and reference_mark > 0, 'SYNFUTURES_MARK_UNCONFIRMED')
    require(type(take_profit_bps) is int and 1 <= take_profit_bps < 10_000,
            'SYNFUTURES_TAKE_PROFIT_CONFIGURATION_REQUIRED')
    require(int(get_decimal('orchestration','campaign_rung_count')) == 5, 'SYNFUTURES_RUNG_CONTRACT_MISMATCH')
    total = decimal_wad(margin_usdc)
    require(total % 5 == 0, 'SYNFUTURES_EXACT_RUNG_MARGIN_REQUIRED')
    span = min(int(get_decimal('ladder','ladder_span_roi') * WAD) // leverage,
               int(get_decimal('ladder','ladder_span_pct_cap') * WAD))
    # Preserve the existing five-rung span. The first rung waits for adverse
    # movement (one fifth of the span), as instructed by the owner.
    offsets = [span // 5] + [span * i // 4 for i in range(1,5)]
    triggers = [reference_mark * (WAD - x if long else WAD + x) // WAD for x in offsets]
    require(all(x > 0 for x in triggers) and all((a>b if long else a<b) for a,b in zip(triggers,triggers[1:])),
            'SYNFUTURES_RUNG_PRICE_COLLISION')
    stop_offset = int(get_decimal('ladder','hard_stop_beyond_last_rung_pct') * WAD)
    stop = triggers[-1] * (WAD - stop_offset if long else WAD + stop_offset) // WAD
    require(stop > 0 and (stop < triggers[-1] if long else stop > triggers[-1]), 'SYNFUTURES_STOP_INVALID')
    return {'version': VERSION, 'symbol': symbol, 'side': 'BUY' if long else 'SELL', 'leverage': leverage,
        'margin_total': str(total), 'margin_per_rung': str(total // 5), 'reference_mark': str(reference_mark),
        'triggers': [str(x) for x in triggers], 'stop_price': str(stop), 'take_profit_bps': take_profit_bps,
        'starting_balance':str(starting_balance),'start_block':str(start_block)}


def next_action(*, campaign, actions, snapshot, entry_halted, now=None):
    """One action at a time, only after exact canonical fills explain exposure."""
    require(type(entry_halted) is bool, 'SYNFUTURES_HALT_UNCONFIRMED')
    clock = snapshot['timestamp'] if now is None else now
    p = snapshot['positions'][campaign['symbol']]
    size, mark = int(p['signed_size']), int(p['mark'])
    long = campaign['side'] == 'BUY'
    require(isinstance(actions,list), 'SYNFUTURES_CAMPAIGN_HISTORY_UNCONFIRMED')
    if any(a.get('state') in ('signing','prepared','submitted','broadcast','unknown','reconciliation_required') for a in actions):
        return {'kind':'wait', 'reason':'SYNFUTURES_TRANSACTION_IN_FLIGHT'}
    confirmed = [a for a in actions if a.get('state') == 'confirmed']
    observed = [a for a in actions if a.get('state') in ('confirmed','mined')]
    expected = sum(int(a['signed_size']) for a in observed)
    entries = [a for a in confirmed if a['kind']=='entry']
    if size==0 and entries and not any(a.get('state')=='mined' for a in actions):
        return {'kind':'close', 'reason':'SYNFUTURES_CANONICAL_FLAT'}
    if size != expected or (size and (size>0) != long):
        return {'kind':'recovery', 'reason':'SYNFUTURES_UNEXPLAINED_POSITION'}
    if any(a.get('state') in ('reverted','failed') for a in actions):
        return {'kind':'exit' if size else 'cancel', 'reason':'SYNFUTURES_CAMPAIGN_ACTION_FAILED'}
    if campaign['status'] in ('closed','cancelled'):
        return {'kind':'wait', 'reason':'SYNFUTURES_CAMPAIGN_TERMINAL'}
    if observed and not size and any(a.get('state') == 'mined' for a in actions):
        return {'kind':'wait', 'reason':'SYNFUTURES_AWAITING_CANONICAL_FINALITY'}
    if int(snapshot['module_revision']) != int(campaign['module_revision']):
        return {'kind':'recovery', 'reason':'SYNFUTURES_SESSION_REVISION_CHANGED'}
    if not snapshot['operator_exit_available']:
        return {'kind':'recovery' if size else 'cancel', 'reason':'SYNFUTURES_OPERATOR_EXIT_UNAVAILABLE'}
    if campaign['status'] in ('closing','recovery_required') or entry_halted or clock + SESSION_EXIT_BUFFER >= snapshot['session_valid_until']:
        return {'kind':'exit' if size else 'cancel', 'reason':'SYNFUTURES_SESSION_EXIT' if clock + SESSION_EXIT_BUFFER >= snapshot['session_valid_until'] else 'SYNFUTURES_ENTRY_PAUSED'}
    stop = int(campaign['plan']['stop_price'])
    if mark <= stop if long else mark >= stop:
        return {'kind':'exit' if size else 'cancel', 'reason':'SYNFUTURES_HARD_STOP'}
    if any(a.get('state') == 'mined' for a in actions):
        return {'kind':'wait', 'reason':'SYNFUTURES_AWAITING_CANONICAL_FINALITY'}
    if len(entries)==5:
        # Full ladder before profit exit. Use the real position's native entry
        # notional, never the pre-submission quote as an execution price.
        basis = int(p['entry_notional'])
        reference = abs(size) * mark // WAD
        tp = campaign['plan']['take_profit_bps']
        hit = reference * 10_000 >= basis * (10_000+tp) if long else reference * 10_000 <= basis * (10_000-tp)
        if hit:return {'kind':'exit','reason':'SYNFUTURES_TAKE_PROFIT'}
        return {'kind':'wait','reason':'SYNFUTURES_POSITION_MONITORED'}
    require(len(entries)<5 and [a['rung'] for a in entries]==list(range(1,len(entries)+1)), 'SYNFUTURES_RUNG_HISTORY_INVALID')
    trigger = int(campaign['plan']['triggers'][len(entries)])
    if mark <= trigger if long else mark >= trigger:
        return {'kind':'entry','rung':len(entries)+1,'reason':'SYNFUTURES_PULLBACK_TRIGGER'}
    return {'kind':'wait','reason':'SYNFUTURES_WAITING_FOR_PULLBACK'}
