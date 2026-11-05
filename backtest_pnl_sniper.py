"""SNIPER backtest v2 — VWAP target + continuation size-up vs OLD opposing-zone.

Runs THREE variants per symbol on the SAME real ApeX klines so results are
directly comparable:

  * old_opposing_zone   — v1 baseline. Target = nearest opposing zone.
                          Stop past fakeout wick. This is the -$510 setup.
  * new_vwap_only       — v2, no continuation. Target = session VWAP.
                          Exit at VWAP whether continuation or not.
  * new_vwap_continue   — v2, full. Target = VWAP; if the reaching candle
                          confirms continuation, add a second tranche
                          (equal margin) at that candle's close and ride
                          to opposing-zone (or FALLBACK_R) secondary TP.
                          Stop unchanged for the whole logical position.

Sizing: 25x, $60 base margin (notional $1500). On size-up, +$60 margin
(+$1500 notional) at the continuation candle close, averaged into a
single position for downstream P&L. Fees + slip charged on every fill
including the add.

Data: real ApeX 5m klines (has volume, required for VWAP) + 1h for zones
and regime. Symbols that range: BTC, ETH, SOL, DOGE, SUI. 90d.
Floor $500. Taker 5bps + slip 2bps per side.

Honest reporting: no fabrication. Prints even when a variant still loses.
"""
from __future__ import annotations

import traceback
from bisect import bisect_right
from dataclasses import dataclass, field
from typing import List, Optional

import market_data as md
import sniper_signal as ss

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

LEVERAGE = 25
BASE_MARGIN = 60.0
BASE_NOTIONAL = BASE_MARGIN * LEVERAGE
STARTING_EQUITY = 600.0
FLOOR = 500.0
TAKER_BPS = 5.0
SLIP_BPS = 2.0
FEE_RATE = TAKER_BPS / 10_000.0
SLIP_RATE = SLIP_BPS / 10_000.0


@dataclass
class Trade:
    variant: str
    direction: str
    entry_i: int
    entry_ts: int
    entry_px: float           # weighted avg entry after any size-up
    stop_px: float
    tp_px: float              # PRIMARY tp at open (VWAP or opposing-zone)
    tp_source: str            # 'vwap' | 'opposing_zone' | 'fallback_R'
    used_fakeout: bool
    qty: float = 0.0
    tranches: int = 1
    added_notional: float = 0.0
    reached_vwap: bool = False
    continued: bool = False
    exit_i: Optional[int] = None
    exit_ts: Optional[int] = None
    exit_px: Optional[float] = None
    exit_reason: str = 'open'
    gross: float = 0.0
    fees: float = 0.0
    slip: float = 0.0
    net: float = 0.0
    hold: int = 0
    secondary_tp_px: Optional[float] = None
    secondary_tp_source: Optional[str] = None


def _entry_costs(notional: float) -> tuple[float, float]:
    return notional * FEE_RATE, notional * SLIP_RATE


def _htf_index_for(ltf_ts: int, htf_open_ts: List[int]) -> int:
    return bisect_right(htf_open_ts, ltf_ts) - 1


def _open_trade(variant: str, direction: str, i: int, ts: int, entry_px: float,
                stop_px: float, tp_px: float, tp_source: str, used_f: bool) -> Trade:
    qty = BASE_NOTIONAL / entry_px
    fees, slip = _entry_costs(BASE_NOTIONAL)
    return Trade(variant=variant, direction=direction, entry_i=i, entry_ts=ts,
                 entry_px=entry_px, stop_px=stop_px, tp_px=tp_px,
                 tp_source=tp_source, used_fakeout=used_f,
                 qty=qty, fees=fees, slip=slip)


def _add_tranche(t: Trade, add_px: float):
    add_qty = BASE_NOTIONAL / add_px
    new_qty = t.qty + add_qty
    # weighted avg entry (avoids double-counting realized moves)
    t.entry_px = (t.entry_px * t.qty + add_px * add_qty) / new_qty
    t.qty = new_qty
    t.tranches += 1
    t.added_notional += BASE_NOTIONAL
    af, asl = _entry_costs(BASE_NOTIONAL)
    t.fees += af
    t.slip += asl


def _finalize(t: Trade, exit_i: int, exit_px: float, ts: int, reason: str):
    exit_notional = t.qty * exit_px
    xf, xsl = _entry_costs(exit_notional)
    t.fees += xf
    t.slip += xsl
    if t.direction == 'long':
        t.gross = (exit_px - t.entry_px) * t.qty
    else:
        t.gross = (t.entry_px - exit_px) * t.qty
    t.net = t.gross - t.fees - t.slip
    t.exit_i = exit_i; t.exit_px = exit_px; t.exit_ts = ts; t.exit_reason = reason
    t.hold = exit_i - t.entry_i


def simulate(ltf, htf, tick: float, variant: str) -> tuple[List[Trade], dict]:
    """variant in {'old_opposing_zone','new_vwap_only','new_vwap_continue'}."""
    zones = ss.find_zones(htf, tick)
    htf_ema = ss.ema(htf)
    htf_open_ts = [int(k[TS]) for k in htf]
    vwap = ss.session_vwap_series(ltf)
    atr5 = ss.wilder_atr(ltf, ss.ATR_PERIOD_LTF)

    trades: List[Trade] = []
    equity = STARTING_EQUITY
    floor_hit = False
    open_pos: Optional[Trade] = None
    scaled_up_count = 0
    ranging_5m = 0; total_gated = 0
    vwap_missing = 0

    n = len(ltf)
    i = 0
    while i < n:
        c = ltf[i]
        ts = int(c[TS])
        j = _htf_index_for(ts, htf_open_ts)
        if j < 0:
            i += 1; continue
        rng = ss.is_ranging_at(htf_ema, j)
        if rng is not None:
            total_gated += 1
            if rng: ranging_5m += 1
        v_now = vwap[i]

        # -------- manage open position --------
        if open_pos is not None:
            hi = float(c[HIGH]); lo = float(c[LOW]); cl = float(c[CLOSE])
            # STOP first (worst-case fill)
            stopped = False
            if open_pos.direction == 'long' and lo <= open_pos.stop_px:
                _finalize(open_pos, i, open_pos.stop_px, ts, 'stop')
                stopped = True
            elif open_pos.direction == 'short' and hi >= open_pos.stop_px:
                _finalize(open_pos, i, open_pos.stop_px, ts, 'stop')
                stopped = True
            if stopped:
                equity += open_pos.net; trades.append(open_pos); open_pos = None
                if equity <= FLOOR: floor_hit = True; break
                i += 1; continue

            # TP behavior differs by variant
            if variant == 'old_opposing_zone':
                if open_pos.direction == 'long' and hi >= open_pos.tp_px:
                    _finalize(open_pos, i, open_pos.tp_px, ts, 'tp_zone')
                    equity += open_pos.net; trades.append(open_pos); open_pos = None
                elif open_pos.direction == 'short' and lo <= open_pos.tp_px:
                    _finalize(open_pos, i, open_pos.tp_px, ts, 'tp_zone')
                    equity += open_pos.net; trades.append(open_pos); open_pos = None
            else:
                # v2: primary tp is dynamic VWAP until reached; then either
                # exit or size-up + secondary tp.
                if not open_pos.reached_vwap:
                    if v_now is None:
                        vwap_missing += 1
                    else:
                        touched = ((open_pos.direction == 'long' and hi >= v_now)
                                   or (open_pos.direction == 'short' and lo <= v_now))
                        if touched:
                            open_pos.reached_vwap = True
                            can_continue = (variant == 'new_vwap_continue'
                                            and ss.continuation_confirmed(
                                                c, v_now, open_pos.direction, atr5[i]))
                            if can_continue:
                                # SIZE UP at reaching-candle close, set secondary tp
                                _add_tranche(open_pos, cl)
                                scaled_up_count += 1
                                open_pos.continued = True
                                opp = ss.opposing_zone_target(
                                    zones, open_pos.direction, open_pos.entry_px, j)
                                if opp is not None:
                                    sec_tp = opp.level; sec_src = 'opposing_zone'
                                else:
                                    risk = abs(open_pos.entry_px - open_pos.stop_px)
                                    if open_pos.direction == 'long':
                                        sec_tp = open_pos.entry_px + ss.FALLBACK_R * risk
                                    else:
                                        sec_tp = open_pos.entry_px - ss.FALLBACK_R * risk
                                    sec_src = 'fallback_R'
                                open_pos.tp_px = sec_tp
                                open_pos.secondary_tp_px = sec_tp
                                open_pos.secondary_tp_source = sec_src
                            else:
                                # exit at VWAP — base hit
                                _finalize(open_pos, i, v_now, ts, 'tp_vwap')
                                equity += open_pos.net; trades.append(open_pos); open_pos = None
                else:
                    # Post-continuation: run to secondary tp (or stop)
                    if open_pos.direction == 'long' and hi >= open_pos.tp_px:
                        _finalize(open_pos, i, open_pos.tp_px, ts, 'tp_secondary')
                        equity += open_pos.net; trades.append(open_pos); open_pos = None
                    elif open_pos.direction == 'short' and lo <= open_pos.tp_px:
                        _finalize(open_pos, i, open_pos.tp_px, ts, 'tp_secondary')
                        equity += open_pos.net; trades.append(open_pos); open_pos = None

            if open_pos is not None:
                if equity <= FLOOR: floor_hit = True; break
                i += 1; continue
            if equity <= FLOOR: floor_hit = True; break

        # -------- entry search --------
        if rng is True and not floor_hit:
            active = ss.active_zones_at(zones, j)
            cl_now = float(c[CLOSE])
            active_sorted = sorted(active, key=lambda z: abs(z.level - cl_now))
            for z in active_sorted:
                res = ss.detect_fakeout_entry(c, z, tick, use_fakeout_filter=True)
                if res is None: continue
                direction, entry_px, stop_px, wick, used_f = res
                if abs(entry_px - stop_px) <= 0: continue
                if variant == 'old_opposing_zone':
                    opp = ss.opposing_zone_target(zones, direction, entry_px, j)
                    if opp is not None:
                        tp_px = opp.level; tp_src = 'opposing_zone'
                    else:
                        risk = abs(entry_px - stop_px)
                        tp_px = (entry_px + ss.FALLBACK_R * risk if direction == 'long'
                                 else entry_px - ss.FALLBACK_R * risk)
                        tp_src = 'fallback_R'
                    if direction == 'long' and tp_px <= entry_px: continue
                    if direction == 'short' and tp_px >= entry_px: continue
                else:
                    # v2: primary tp is dynamic VWAP; require VWAP available
                    # and on the profitable side of entry
                    v = vwap[i]
                    if v is None: continue
                    if direction == 'long' and v <= entry_px: continue
                    if direction == 'short' and v >= entry_px: continue
                    tp_px = v  # dynamic; refreshed each tick above
                    tp_src = 'vwap'
                open_pos = _open_trade(variant, direction, i, ts, entry_px,
                                       stop_px, tp_px, tp_src, used_f)
                break
        i += 1

    if open_pos is not None:
        _finalize(open_pos, n - 1, float(ltf[-1][CLOSE]), int(ltf[-1][TS]), 'end_of_data')
        trades.append(open_pos)

    return trades, {
        'ranging_pct': (ranging_5m / total_gated * 100) if total_gated else 0.0,
        'zones': len(zones),
        'floor_hit': floor_hit,
        'scaled_up': scaled_up_count,
        'vwap_missing': vwap_missing,
    }


def summarize(symbol: str, variant: str, trades: List[Trade], stats: dict) -> dict:
    closed = [t for t in trades if t.exit_reason != 'open']
    wins = [t for t in closed if t.net > 0]
    losses = [t for t in closed if t.net <= 0]
    net = sum(t.net for t in closed)
    wr = (len(wins) / len(closed) * 100) if closed else 0.0
    avg_w = (sum(t.net for t in wins) / len(wins)) if wins else 0.0
    avg_l = (sum(t.net for t in losses) / len(losses)) if losses else 0.0
    payoff = (avg_w / abs(avg_l)) if avg_l < 0 else (float('inf') if avg_w > 0 else 0.0)
    best = max((t.net for t in closed), default=0.0)
    worst = min((t.net for t in closed), default=0.0)
    equity = STARTING_EQUITY; peak = equity; dd = 0.0
    for t in closed:
        equity += t.net; peak = max(peak, equity); dd = max(dd, peak - equity)
    reasons: dict = {}
    for t in closed: reasons[t.exit_reason] = reasons.get(t.exit_reason, 0) + 1
    reached_vwap = sum(1 for t in closed if t.reached_vwap)
    continued = sum(1 for t in closed if t.continued)
    pct_reached = (reached_vwap / len(closed) * 100) if closed else 0.0
    pct_continued = (continued / len(closed) * 100) if closed else 0.0
    print(f"  {variant:20s}  trades={len(closed):3d}  wr={wr:5.1f}%  "
          f"avgW=${avg_w:+7.2f}  avgL=${avg_l:+7.2f}  payoff={payoff:5.2f}  "
          f"NET=${net:+8.2f}  DD=${dd:6.2f}  best=${best:+7.2f} worst=${worst:+7.2f}")
    print(f"    reasons={reasons}  floor={stats['floor_hit']}  "
          f"reached_vwap={pct_reached:.0f}%  continued={pct_continued:.0f}%  "
          f"zones={stats['zones']}  ranging={stats['ranging_pct']:.0f}%")
    return {'symbol': symbol, 'variant': variant, 'trades': len(closed),
            'wr': wr, 'net': net, 'dd': dd,
            'pct_reached': pct_reached, 'pct_continued': pct_continued,
            'floor': stats['floor_hit']}


def run_symbol(symbol: str, days: int) -> list[dict]:
    feed = md.ApexPublicFeed()
    print(f"\n===== {symbol} =====")
    hours = days * 24
    try:
        ltf = feed.fetch_range(symbol, 5, hours=hours)
        htf = feed.fetch_range(symbol, 60, hours=hours)
    except Exception as e:
        print(f"  FEED ERROR: {e}"); return []
    span_h = (int(ltf.candles[-1][TS]) - int(ltf.candles[0][TS])) / 3_600_000
    print(f"  5m={len(ltf.candles)} 1h={len(htf.candles)} tick={ltf.tick} "
          f"span={span_h:.1f}h ({span_h/24:.1f}d)")
    rows = []
    for variant in ('old_opposing_zone', 'new_vwap_only', 'new_vwap_continue'):
        trades, stats = simulate(ltf.candles, htf.candles, ltf.tick, variant)
        rows.append(summarize(symbol, variant, trades, stats))
    return rows


def main():
    days = 90
    symbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "DOGE-USDT", "SUI-USDT"]
    print("=" * 82)
    print("SNIPER v2 BACKTEST — VWAP magnet + continuation size-up  vs  v1 opposing-zone")
    print(f"  window={days}d  leverage={LEVERAGE}x  base_margin=${BASE_MARGIN}  "
          f"floor=${FLOOR}  fee={TAKER_BPS}bps  slip={SLIP_BPS}bps")
    print(f"  regime: 1h EMA{ss.EMA_PERIOD} slope <= {ss.FLAT_PCT*100:.1f}% over "
          f"{ss.SLOPE_LOOKBACK}h => ranging  |  session VWAP resets 00:00 UTC")
    print("=" * 82)
    all_rows: list[dict] = []
    for s in symbols:
        try:
            all_rows.extend(run_symbol(s, days))
        except Exception:
            traceback.print_exc()
    print("\n" + "=" * 82)
    print("PORTFOLIO TOTALS (sum across symbols)")
    print("=" * 82)
    for variant in ('old_opposing_zone', 'new_vwap_only', 'new_vwap_continue'):
        vs = [r for r in all_rows if r['variant'] == variant]
        if not vs: continue
        net = sum(r['net'] for r in vs)
        trades = sum(r['trades'] for r in vs)
        wr = (sum(r['wr'] * r['trades'] for r in vs) / trades) if trades else 0.0
        floored = sum(1 for r in vs if r['floor'])
        reached = (sum(r['pct_reached'] * r['trades'] for r in vs) / trades) if trades else 0.0
        cont = (sum(r['pct_continued'] * r['trades'] for r in vs) / trades) if trades else 0.0
        print(f"  {variant:20s}  symbols={len(vs)}  trades={trades:4d}  wr={wr:5.1f}%  "
              f"NET=${net:+9.2f}  floored={floored}/{len(vs)}  "
              f"reached_vwap={reached:.0f}%  continued={cont:.0f}%")


if __name__ == '__main__':
    main()
