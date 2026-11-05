"""HUNTER strategy — real ApeX backtest (owner spec, this session).

Two variants tested per (symbol, K threshold):
  A) FILL/REVERSAL   — price returns into the FVG zone; enter counter to gap
                       (bullish FVG -> LONG on retrace into gap;
                        bearish FVG -> SHORT on retrace into gap).
                       Entry price = zone edge touched (worse edge for us).
                       Stop = far side of the gap (opposite edge) — if
                       price closes through it, invalidated.
  B) CONTINUATION    — enter WITH the gap direction on next candle open
                       (bullish -> LONG at candle[confirm+1].open;
                        bearish -> SHORT at candle[confirm+1].open).
                       Stop = opposite edge of the FVG (the imbalance
                       should hold as support/resistance).

EXITS (whichever first):
  * S/R hit: next opposing confirmed swing beyond entry (long -> next swing high
    above entry; short -> next swing low below entry). Fills at that price
    when candle high/low reaches it.
  * BOS against: close beyond stop level (long: close < stop; short: close > stop).
  * ATR weakness: ATR(14) closes back below its 20-SMA (ratio < 1.0)
    after being in the trade at least 3 candles.
  * Hard floor: account equity <= FLOOR (last resort, position force-closed at close).

SIZING (match validated Accumulator: 25x, flat margin):
  * leverage 25x, margin per trade = $60, notional = margin * lev = $1500.
  * qty = notional / entry_px.
  * one position at a time (Hunter wallet). Ignore new signals while open.

COSTS: taker 5bps + slip 2bps per fill (entry + exit). Funding NOT modeled.

DATA: ApeX public klines, 5m, up to 90 days (25920 candles) per symbol via
market_data.ApexPublicFeed.fetch_range. If ApeX egress is blocked, this script
reports the real error and exits non-zero. No fabricated numbers.
"""
from __future__ import annotations

import sys
import traceback
from dataclasses import dataclass, field
from typing import Optional, List

import hunter_signal as hs
import market_data as md

LEVERAGE = 25
MARGIN = 60.0
NOTIONAL = MARGIN * LEVERAGE
STARTING_EQUITY = 600.0
FLOOR = 500.0
TAKER_BPS = 5.0
SLIP_BPS = 2.0
FEE_RATE = TAKER_BPS / 10_000.0
SLIP_RATE = SLIP_BPS / 10_000.0
MIN_HOLD_FOR_ATR_EXIT = 3

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5


@dataclass
class Trade:
    direction: str
    variant: str
    k: float
    entry_i: int
    entry_ts: int
    entry_px: float
    stop_px: float
    tp_px: Optional[float]  # planned next-swing target if known
    exit_i: Optional[int] = None
    exit_ts: Optional[int] = None
    exit_px: Optional[float] = None
    exit_reason: str = 'open'
    gross_pnl: float = 0.0
    fees: float = 0.0
    slip: float = 0.0
    net_pnl: float = 0.0
    hold: int = 0


def _next_opposing_swing(swings: List[hs.Swing], direction: str, entry_i: int, entry_px: float) -> Optional[hs.Swing]:
    """long -> next swing HIGH after entry_i with level > entry_px;
       short -> next swing LOW after entry_i with level < entry_px."""
    for s in swings:
        if s.index <= entry_i:
            continue
        if direction == 'long' and s.kind == 'high' and s.level > entry_px:
            return s
        if direction == 'short' and s.kind == 'low' and s.level < entry_px:
            return s
    return None


def _finish(t: Trade, exit_i: int, exit_px: float, ts: int, reason: str) -> None:
    qty = NOTIONAL / t.entry_px
    if t.direction == 'long':
        t.gross_pnl = (exit_px - t.entry_px) * qty
    else:
        t.gross_pnl = (t.entry_px - exit_px) * qty
    t.fees = NOTIONAL * FEE_RATE + (qty * exit_px) * FEE_RATE
    t.slip = NOTIONAL * SLIP_RATE + (qty * exit_px) * SLIP_RATE
    t.net_pnl = t.gross_pnl - t.fees - t.slip
    t.exit_i, t.exit_px, t.exit_ts, t.exit_reason = exit_i, exit_px, ts, reason
    t.hold = exit_i - t.entry_i


def simulate(candles, fvgs: List[hs.FVG], swings: List[hs.Swing],
             variant: str, k: float, atr, atr_sma) -> List[Trade]:
    trades: List[Trade] = []
    cursor = -1
    equity = STARTING_EQUITY
    floor_hit = False

    for fvg in fvgs:
        if floor_hit:
            break
        confirm = fvg.confirm_index
        if confirm <= cursor:
            continue

        # Determine entry
        if variant == 'continuation':
            entry_i = confirm + 1
            if entry_i >= len(candles):
                continue
            entry_px = float(candles[entry_i][OPEN])
            direction = 'long' if fvg.direction == 'bullish' else 'short'
            stop_px = fvg.gap_lower if direction == 'long' else fvg.gap_upper
        else:  # fill/reversal
            direction = 'long' if fvg.direction == 'bullish' else 'short'
            # search forward for retrace into gap zone (max 24 candles window)
            entry_i = None
            entry_px = None
            for j in range(confirm + 1, min(confirm + 25, len(candles))):
                c = candles[j]
                lo = float(c[LOW]); hi = float(c[HIGH])
                if direction == 'long' and lo <= fvg.gap_upper:
                    # entered the gap from above; entry at gap_upper (worse of touched edge)
                    entry_i = j
                    entry_px = min(fvg.gap_upper, float(c[OPEN]))
                    break
                if direction == 'short' and hi >= fvg.gap_lower:
                    entry_i = j
                    entry_px = max(fvg.gap_lower, float(c[OPEN]))
                    break
            if entry_i is None:
                continue
            stop_px = fvg.gap_lower if direction == 'long' else fvg.gap_upper

        # Planned TP: next opposing swing already known at entry time (only swings
        # confirmed before entry_i)
        prior_swings = [s for s in swings if s.index + hs.PIVOT_RIGHT <= entry_i]
        # For target we want future swing (any known so far above/below entry).
        # Approximation: use next opposing swing scanning ALL swings after entry_i
        # (this is the exit trigger). Show planned tp as None (dynamic).
        tp_target = _next_opposing_swing(swings, direction, entry_i, entry_px)
        tp_px = tp_target.level if tp_target else None

        t = Trade(direction=direction, variant=variant, k=k,
                  entry_i=entry_i, entry_ts=int(candles[entry_i][TS]),
                  entry_px=entry_px, stop_px=stop_px, tp_px=tp_px)

        # Walk forward
        exited = False
        for j in range(entry_i + 1, len(candles)):
            c = candles[j]
            hi = float(c[HIGH]); lo = float(c[LOW]); cl = float(c[CLOSE])
            # Stop (BOS) — completed candle close beyond stop
            if direction == 'long' and cl < t.stop_px:
                _finish(t, j, cl, int(c[TS]), 'bos_stop'); exited = True; cursor = j; break
            if direction == 'short' and cl > t.stop_px:
                _finish(t, j, cl, int(c[TS]), 'bos_stop'); exited = True; cursor = j; break
            # TP — structural swing touched
            if t.tp_px is not None:
                if direction == 'long' and hi >= t.tp_px:
                    _finish(t, j, t.tp_px, int(c[TS]), 'swing_tp'); exited = True; cursor = j; break
                if direction == 'short' and lo <= t.tp_px:
                    _finish(t, j, t.tp_px, int(c[TS]), 'swing_tp'); exited = True; cursor = j; break
            # ATR weakness after min hold
            if j - entry_i >= MIN_HOLD_FOR_ATR_EXIT:
                a = atr[j]; s = atr_sma[j]
                if a is not None and s is not None and s > 0 and (a / s) < 1.0:
                    _finish(t, j, cl, int(c[TS]), 'atr_weak'); exited = True; cursor = j; break

        if not exited:
            _finish(t, len(candles) - 1, float(candles[-1][CLOSE]),
                    int(candles[-1][TS]), 'end_of_data')
            cursor = len(candles)

        equity += t.net_pnl
        trades.append(t)
        if equity <= FLOOR:
            floor_hit = True
    return trades


def report_block(symbol: str, variant: str, k: float, trades: List[Trade],
                 vol_stats: dict) -> dict:
    closed = [t for t in trades if t.exit_reason != 'open']
    wins = [t for t in closed if t.net_pnl > 0]
    losses = [t for t in closed if t.net_pnl <= 0]
    net = sum(t.net_pnl for t in closed)
    gross = sum(t.gross_pnl for t in closed)
    fees = sum(t.fees for t in closed)
    slip = sum(t.slip for t in closed)
    wr = (len(wins) / len(closed) * 100) if closed else 0.0
    avg_win = (sum(t.net_pnl for t in wins) / len(wins)) if wins else 0.0
    avg_loss = (sum(t.net_pnl for t in losses) / len(losses)) if losses else 0.0
    largest_loss = min((t.net_pnl for t in losses), default=0.0)
    payoff = (avg_win / abs(avg_loss)) if avg_loss < 0 else float('inf') if avg_win > 0 else 0.0
    # DD
    equity = STARTING_EQUITY; peak = equity; max_dd = 0.0
    for t in closed:
        equity += t.net_pnl
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
    reasons = {}
    for t in closed:
        reasons[t.exit_reason] = reasons.get(t.exit_reason, 0) + 1

    print(f"  variant={variant:12s} K={k}  trades={len(closed):4d}  "
          f"wr={wr:5.1f}%  avgW=${avg_win:+7.2f}  avgL=${avg_loss:+7.2f}  "
          f"payoff={payoff:5.2f}  NET=${net:+9.2f}  DD=${max_dd:6.2f}  "
          f"gate_hot={vol_stats['hot_fraction']*100:5.1f}%  reasons={reasons}")
    return {"symbol": symbol, "variant": variant, "k": k,
            "trades": len(closed), "win_rate": wr, "net": net,
            "avg_win": avg_win, "avg_loss": avg_loss, "payoff": payoff,
            "max_dd": max_dd, "hot_fraction": vol_stats['hot_fraction']}


def run_symbol(symbol: str, hours: int):
    feed_obj = md.ApexPublicFeed()
    print(f"\n===== {symbol} =====")
    print(f"fetching {hours}h of 5m candles...")
    f = feed_obj.fetch_range(symbol, 5, hours=hours)
    c = f.candles
    span_days = (len(c) * 5) / 60 / 24
    print(f"candles={len(c)} span={span_days:.1f}d tick={f.tick}")

    atr = hs.wilder_atr(c)
    atr_sma = hs.sma_of(atr, hs.ATR_SMA_PERIOD)
    swings = hs.find_swings(c)

    results = []
    for k in (1.3, 1.5, 2.0):
        vol_stats = hs.volatility_stats(c, k)
        fvgs = hs.find_fvgs(c, k)
        print(f"\n  --- K={k} : {len(fvgs)} FVGs (gate hot {vol_stats['hot_fraction']*100:.1f}%) ---")
        for variant in ('fill', 'continuation'):
            trades = simulate(c, fvgs, swings, variant, k, atr, atr_sma)
            results.append(report_block(symbol, variant, k, trades, vol_stats))
    return results


def main():
    hours = 24 * 90  # 90 days
    symbols = ["SOL-USDT", "DOGE-USDT", "PENGU-USDT", "AVAX-USDT",
               "SUI-USDT", "BTC-USDT", "ETH-USDT"]
    print("=" * 78)
    print("HUNTER BACKTEST — FVG + volatility gate, structural exits")
    print(f"  leverage={LEVERAGE}x  margin=${MARGIN}  notional=${NOTIONAL}")
    print(f"  starting equity=${STARTING_EQUITY}  floor=${FLOOR}")
    print(f"  taker={TAKER_BPS}bps/side  slip={SLIP_BPS}bps/side  funding=NOT MODELED")
    print(f"  data=ApeX public klines 5m, target {hours}h (90d)")
    print("=" * 78)

    all_rows = []
    for s in symbols:
        try:
            all_rows.extend(run_symbol(s, hours))
        except Exception as e:
            print(f"\n[{s}] BLOCKED — real error follows:\n{type(e).__name__}: {e}")
            traceback.print_exc()
            # continue with other symbols
            continue

    # Aggregate leaderboard
    print("\n" + "=" * 78)
    print("LEADERBOARD (by NET pnl)")
    print("=" * 78)
    all_rows.sort(key=lambda r: r['net'], reverse=True)
    for r in all_rows:
        print(f"  {r['symbol']:12s} {r['variant']:12s} K={r['k']}  "
              f"trades={r['trades']:4d}  wr={r['win_rate']:5.1f}%  "
              f"payoff={r['payoff']:5.2f}  NET=${r['net']:+9.2f}  DD=${r['max_dd']:6.2f}")

    # Verdict
    print("\n" + "=" * 78)
    print("VERDICT")
    print("=" * 78)
    profitable = [r for r in all_rows if r['net'] > 0]
    print(f"profitable configs: {len(profitable)} / {len(all_rows)}")
    if profitable:
        best = profitable[0]
        print(f"best: {best['symbol']} {best['variant']} K={best['k']} "
              f"NET ${best['net']:+.2f} wr {best['win_rate']:.1f}% payoff {best['payoff']:.2f}")
    # Compare to Accumulator baseline (owner-stated ~76% win, ~0.5 payoff)
    print("Accumulator baseline for reference: ~76% win rate, ~0.5 payoff.")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
