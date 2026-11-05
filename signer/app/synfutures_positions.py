"""Verified native position monitoring and owner-reviewed Safe recovery calls.

Reads survive paused entries and expired/revoked sessions. No key is needed.
Recovery uses explicit owner transactions: enable the registered module if
needed, authorize only the owner for a short recovery session, then freshly
quote an atomic reduce-only module call. No direct trade can reverse exposure.
"""
import time
from eth_abi import encode, decode
from eth_utils import keccak
from . import synfutures_account as native
from .synfutures_entry import require
from .synfutures_reconciliation import quantity, ADDRESS, HASH
from shared.synfutures_math import WAD, tick_at_price, price_at_tick

ZERO = '0x' + '00' * 20


def contract_call(rpc, at, address, signature, types=(), args=(), outputs=()):
    data = '0x' + (keccak(text=signature)[:4] + encode(types, args)).hex()
    result = rpc('eth_call', [{'to': address, 'data': data}, at])
    require(isinstance(result, str) and result.startswith('0x'), 'SYNFUTURES_CALL_UNCONFIRMED')
    return decode(outputs, bytes.fromhex(result[2:]))


def read_positions(*, db, rpc, user_id, connection_id, now=None):
    context = db.synfutures_account_context(user_id=user_id, connection_id=connection_id)
    require(isinstance(context, dict) and context.get('chain_id') == 8453, 'SYNFUTURES_BINDING_UNCONFIRMED')
    require(quantity(rpc('eth_chainId', [])) == 8453, 'SYNFUTURES_CHAIN_MISMATCH')
    block = rpc('eth_getBlockByNumber', ['latest', False])
    clock = int(time.time()) if now is None else now
    require(isinstance(block, dict) and isinstance(block.get('hash'), str) and HASH.fullmatch(block['hash'])
            and 0 <= clock - quantity(block.get('timestamp')) <= 30, 'SYNFUTURES_BLOCK_STALE')
    at = {'blockHash': block['hash'], 'requireCanonical': True}
    safe, module, owner = (context.get(k) for k in ('safe_address', 'module_address', 'owner_address'))
    require(all(isinstance(x, str) and ADDRESS.fullmatch(x) and int(x, 16) != 0 for x in (safe, module, owner)),
            'SYNFUTURES_BINDING_UNCONFIRMED')
    for address, field in ((safe, 'safe_proxy_code_hash'), (module, 'module_code_hash')):
        code = rpc('eth_getCode', [address, at])
        require(isinstance(code, str) and code != '0x'
                and '0x' + keccak(bytes.fromhex(code[2:])).hex() == context.get(field), 'SYNFUTURES_CODE_CHANGED')
    singleton = rpc('eth_getCode', [native.SINGLETON, at])
    slot = rpc('eth_getStorageAt', [safe, '0x' + '00' * 32, at])
    require(slot == '0x' + '00' * 12 + native.SINGLETON[2:] and isinstance(singleton, str)
            and '0x' + keccak(bytes.fromhex(singleton[2:])).hex() == native.SINGLETON_HASH,
            'SYNFUTURES_SAFE_IMPLEMENTATION_CHANGED')
    call = lambda addr, sig, types=(), args=(), outputs=(): contract_call(rpc, at, addr, sig, types, args, outputs)
    owners = call(safe, 'getOwners()', outputs=['address[]'])[0]
    require(len(owners) == 1 and owners[0].lower() == owner
            and call(safe, 'getThreshold()', outputs=['uint256'])[0] == 1
            and call(module, 'safe()', outputs=['address'])[0].lower() == safe, 'SYNFUTURES_OWNER_CHANGED')
    enabled = call(safe, 'isModuleEnabled(address)', ['address'], [module], ['bool'])[0]
    session = call(module, 'session()', outputs=['address','uint48','uint128','uint128','uint16'])
    revision = call(module, 'revision()', outputs=['uint256'])[0]
    nonce = call(module, 'nextNonce()', outputs=['uint256'])[0]
    reserve = call(native.GATE, 'reserveOf(address,address)', ['address','address'], [native.USDC, safe], ['uint256'])[0]
    require(call(native.GATE, 'config()', outputs=['address'])[0].lower() == native.CONFIG, 'SYNFUTURES_VENUE_MISMATCH')
    positions = {}
    for symbol, instrument in native.MARKETS.items():
        setting = call(native.OBSERVER, 'getSetting(address)', ['address'], [instrument], [native.SETTING])[0]
        require(setting[1].lower() == native.CONFIG and setting[2].lower() == native.GATE
                and setting[4].lower() == native.USDC and setting[5] == 6, 'SYNFUTURES_VENUE_MISMATCH')
        p = call(native.OBSERVER, 'getPosition(address,uint32,address)', ['address','uint32','address'],
                 [instrument, 2**32-1, safe], [native.POSITION])[0]
        q = call(instrument, 'inquire(uint32,int256)', ['uint32','int256'], [2**32-1, -p[1] if p[1] else 1], [native.QUOTE])[0]
        require(q[3] > 0 and (q[4] > 0 if p[1] else q[4] >= 0) and q[5] >= 0,
                'SYNFUTURES_POSITION_VALUE_UNCONFIRMED')
        positions[symbol] = {'instrument_address': instrument, 'signed_size': str(p[1]),
            'balance': str(p[0]), 'entry_notional': str(p[2]),
            'mark': str(q[3]), 'close_notional': str(q[4]) if p[1] else None,
            'close_fee': str(q[5]) if p[1] else None}
    canonical = rpc('eth_getBlockByNumber', [block['number'], False])
    require(isinstance(canonical, dict) and canonical.get('hash') == block['hash'], 'SYNFUTURES_BLOCK_CHANGED')
    require(now is not None or 0 <= int(time.time()) - quantity(block['timestamp']) <= 30, 'SYNFUTURES_BLOCK_STALE')
    return {'chain_id': 8453, 'safe_address': safe, 'module_address': module, 'owner_address': owner,
        'operator_address': session[0].lower(), 'session_valid_until': session[1], 'slippage_bps': session[4],
        'margin_budget': str(session[2]), 'margin_spent': str(session[3]), 'reserve': str(reserve * 10**12),
        'module_revision': str(revision), 'module_nonce': str(nonce), 'module_enabled': enabled,
        'operator_exit_available': enabled and int(session[0],16) != 0 and session[1] > clock,
        'live_entry_allowed': context.get('live_entry_allowed') is True, 'positions': positions,
        'observed_block': str(quantity(block['number'])), 'block_hash': block['hash'], 'timestamp': quantity(block['timestamp'])}


def limit_tick(mark, long, bps):
    require(type(mark) is int and mark > 0 and type(bps) is int and 0 < bps < 10_000,
            'SYNFUTURES_SLIPPAGE_INVALID')
    bound = mark * (10_000 + bps if long else 10_000 - bps) // 10_000
    tick = tick_at_price(bound)
    return tick + (not long and price_at_tick(tick) < bound)


def safe_owner_call(snapshot, target, data):
    # Safe 1.4.1 single-owner threshold-1 prevalidated signature. msg.sender must
    # be this freshly verified owner; another EOA cannot use these public bytes.
    signature = bytes.fromhex(snapshot['owner_address'][2:].rjust(64, '0')) + bytes(32) + b'\x01'
    types = ['address','uint256','bytes','uint8','uint256','uint256','uint256','address','address','bytes']
    args = [target, 0, bytes.fromhex(data[2:]), 0, 0, 0, 0, ZERO, ZERO, signature]
    sig = 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)'
    return {'chain_id': 8453, 'from': snapshot['owner_address'], 'to': snapshot['safe_address'],
            'value': '0x0', 'data': '0x' + (keccak(text=sig)[:4] + encode(types, args)).hex()}


def owner_recovery(*, snapshot, rpc, symbol, slippage_bps):
    require(symbol in native.MARKETS, 'SYNFUTURES_SYMBOL_UNSUPPORTED')
    require(type(slippage_bps) is int and 1 <= slippage_bps <= 1000, 'SYNFUTURES_SLIPPAGE_INVALID')
    p = snapshot['positions'][symbol]
    size = int(p['signed_size'])
    require(size != 0 and abs(size) < 2**127, 'SYNFUTURES_RECOVERY_NO_POSITION')
    if not snapshot['module_enabled']:
        phase = 'enable_module'
        data = '0x' + (keccak(text='enableModule(address)')[:4] + encode(['address'],[snapshot['module_address']])).hex()
        call = safe_owner_call(snapshot,snapshot['safe_address'],data)
    elif snapshot['operator_address'] != snapshot['owner_address'] or snapshot['session_valid_until'] <= snapshot['timestamp'] + 30:
        phase = 'authorize_owner_exit'
        # Replaces and invalidates queued worker authority. Budget is one WAD
        # wei, not one USDC: recovery adds no margin and cannot fund an entry.
        args = [snapshot['owner_address'],snapshot['timestamp']+300,1,slippage_bps]
        data = '0x' + (keccak(text='configureSession(address,uint48,uint128,uint16)')[:4]
                       + encode(['address','uint48','uint128','uint16'],args)).hex()
        call = safe_owner_call(snapshot,snapshot['module_address'],data)
    else:
        phase = 'close_position'
        deadline = min(snapshot['timestamp'] + 120,snapshot['session_valid_until'])
        tick = limit_tick(int(p['mark']), size < 0, slippage_bps)
        signature = 'executeTrade((uint256,uint256,address,int128,uint128,int24,uint32,bool))'
        args = (int(snapshot['module_revision']),int(snapshot['module_nonce']),p['instrument_address'],-size,0,tick,deadline,True)
        call = {'chain_id':8453,'from':snapshot['owner_address'],'to':snapshot['module_address'],'value':'0x0',
                'data':'0x'+(keccak(text=signature)[:4]+encode(['(uint256,uint256,address,int128,uint128,int24,uint32,bool)'],[args])).hex()}
    # Safe execTransaction returns bool. A mined status=1 alone is insufficient:
    # UI must reread revoked session/flat native position after owner confirmation.
    result = rpc('eth_call', [{k:v for k,v in call.items() if k != 'chain_id'}, 'pending'])
    require(result == '0x' if phase == 'close_position' else
            isinstance(result,str) and decode(['bool'],bytes.fromhex(result[2:]))[0] is True,
            'SYNFUTURES_RECOVERY_SIMULATION_UNCONFIRMED')
    return {'phase': phase, 'symbol': symbol, 'signed_position_size': p['signed_size'],
            'observed_block': snapshot['observed_block'], 'call': call,
            'expires_at': snapshot['timestamp'] + 120, 'owner_confirmation_required': True}
