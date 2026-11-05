"""Real P&L backtest for the Accumulator (owner-ratified spec, this session).

READS the strategy from accumulator_signal.py; does NOT modify it. Reuses:
  - sig.evaluate() to get confirmed retests (entries) per direction
  - the SAME frozen zone (be.zone) that defined entry to define the BOS stop:
      long  -> exit on first candle with close < zone.lower
      short -> exit on first candle with close > zone.upper
    This is exactly the retest expired_breach edge, reused post-entry.

TRADE SPEC (owner-ratified this session)
  * leverage 20x, futures cross-margin, ApeX Omni
  * entry: at RetestResult.state=='confirmed' -> fill at close of retest candle
  * size:  notional = capital_baseline($30) * sizing.notional_constant(10) = $300
           => qty = 300 / entry_price; margin = 300/20 = $15; margin_fraction=0.5
  * stop:  first COMPLETED candle close beyond frozen zone edge (confirmed BOS)
  * target: FLAT +$30 realized profit AFTER leverage (owner override of S39 TP1/2/3)
           => exit price for long  = entry * (1 + 30/300)  = entry * 1.10
                              short = entry * (1 - 30/300) = entry * 0.90
  * one position at a time: yes. New signals ignored until flat.
  * priority same-candle: STOP fills before TARGET (worst case).

COSTS (explicitly stated; the report prints these too)
  * taker fee: 0.05% per side (ApeX Omni published taker rate)
  * slippage:  2 bps per side (assumption; small, symmetric)
  * funding:   NOT modeled. ApeX pays funding hourly on perps; historical
               funding not fetched here. Reported separately; net excludes it.

DATA
  * 7 days (168h) of 5m candles per symbol from ApeX public klines via
    market_data.ApexPublicFeed.fetch_range (same source as backtest_entries.py).

If ApeX egress is blocked in this environment, this script reports the real
error and exits non-zero. No fabricated numbers.
"""
from __future__ import annotations

import sys
import traceback
from dataclasses import dataclass
from typing import Optional

import accumulator_signal as sig
import market_data as md

# Cost + spec constants (all printed in the report)
LEVERAGE = 20
CAPITAL = 30.0                # pilot baseline USD
NOTIONAL = CAPITAL * 10       # $300, per sizing.notional_constant=10
MARGIN = NOTIONAL / LEVERAGE  # $15
TARGET_USD = 30.0             # flat +$30 realized (owner override)
TAKER_FEE_BPS = 5.0           # 0.05% ApeX Omni taker
SLIPPAGE_BPS = 2.0            # small assumption per side
FEE_RATE = TAKER_FEE_BPS / 10_000.0
SLIP_RATE = SLIPPAGE_BPS / 10_000.0

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5


@dataclass
class Trade:
    direction: str
    entry_i: int
    entry_ts: float
    entry_px: float
    exit_i: Optional[int] = None
    exit_ts: Optional[float] = None
    exit_px: Optional[float] = None
    outcome: str = "open"      # 'target' | 'stop' | 'open'
    gross_pnl: float = 0.0
    fees: float = 0.0
    slippage_cost: float = 0.0
    net_pnl: float = 0.0
    hold_candles: int = 0


def _finish(t: Trade, exit_i: int, exit_px: float, ts: float, outcome: str) -> None:
    qty = NOTIONAL / t.entry_px
    if t.direction == "long":
        t.gross_pnl = (exit_px - t.entry_px) * qty
    else:
        t.gross_pnl = (t.entry_px - exit_px) * qty
    # fees on entry + exit notional
    t.fees = NOTIONAL * FEE_RATE + (qty * exit_px) * FEE_RATE
    # slippage: entry filled worse by SLIP_RATE, exit filled worse by SLIP_RATE
    t.slippage_cost = (NOTIONAL * SLIP_RATE) + (qty * exit_px * SLIP_RATE)
    t.net_pnl = t.gross_pnl - t.fees - t.slippage_cost
    t.exit_i, t.exit_px, t.exit_ts, t.outcome = exit_i, exit_px, ts, outcome
    t.hold_candles = exit_i - t.entry_i


def simulate(candles, entries_long, entries_short) -> list[Trade]:
    """Merge both-direction entries, honor one-at-a-time, walk forward for exit."""
    # Build (entry_index, direction, zone, entry_ts) list from RetestResults
    evs = []
    for r in entries_long:
        evs.append((r.retest_index, "long", r.break_event.zone, r.retest_ts))
    for r in entries_short:
        evs.append((r.retest_index, "short", r.break_event.zone, r.retest_ts))
    evs.sort(key=lambda x: x[0])

    trades: list[Trade] = []
    cursor = -1  # index of last exit; new entries must be strictly after
    for entry_i, direction, zone, entry_ts in evs:
        if entry_i <= cursor:
            continue  # ignored: position still open
        entry_px = float(candles[entry_i][CLOSE])
        t = Trade(direction, entry_i, entry_ts, entry_px)
        # target price at flat +$30
        qty = NOTIONAL / entry_px
        target_move = TARGET_USD / qty  # price move needed
        if direction == "long":
            target_px = entry_px + target_move
        else:
            target_px = entry_px - target_move

        exited = False
        for j in range(entry_i + 1, len(candles)):
            c = candles[j]
            hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])
            # STOP: completed candle close beyond frozen zone edge
            if direction == "long":
                stop_hit = cl < zone.lower
                target_hit = hi >= target_px
            else:
                stop_hit = cl > zone.upper
                target_hit = lo <= target_px
            # STOP priority when both trigger same candle (worst case)
            if stop_hit:
                _finish(t, j, cl, float(c[TS]), "stop")
                exited = True; cursor = j; break
            if target_hit:
                _finish(t, j, target_px, float(c[TS]), "target")
                exited = True; cursor = j; break
        if not exited:
            t.outcome = "open"
            cursor = len(candles)  # block further entries in this window
        trades.append(t)
    return trades


def run(symbol: str, hours: int) -> dict:
    feed = md.ApexPublicFeed()
    print(f"[{symbol}] fetching {hours}h of 5m candles via ApeX public klines...")
    f = feed.fetch_range(symbol, 5, hours=hours)
    c = f.candles
    print(f"[{symbol}] candles={len(c)} tick={f.tick} span={(len(c)*5)/60:.1f}h age_sec={f.age_sec:.1f}")

    long_eval = sig.evaluate(c, "long", f.tick)
    short_eval = sig.evaluate(c, "short", f.tick)
    print(f"[{symbol}] confirmed entries: long={len(long_eval['entries'])} short={len(short_eval['entries'])}")

    trades = simulate(c, long_eval["entries"], short_eval["entries"])
    return {"symbol": symbol, "candles": c, "trades": trades, "hours": (len(c) * 5) / 60}


def report(res: dict) -> None:
    sym = res["symbol"]; trades: list[Trade] = res["trades"]
    wins = [t for t in trades if t.outcome == "target"]
    losses = [t for t in trades if t.outcome == "stop"]
    opens = [t for t in trades if t.outcome == "open"]

    gross = sum(t.gross_pnl for t in trades if t.outcome != "open")
    fees = sum(t.fees for t in trades if t.outcome != "open")
    slip = sum(t.slippage_cost for t in trades if t.outcome != "open")
    net = sum(t.net_pnl for t in trades if t.outcome != "open")

    closed = len(wins) + len(losses)
    win_rate = (len(wins) / closed * 100) if closed else 0.0
    avg_win = (sum(t.net_pnl for t in wins) / len(wins)) if wins else 0.0
    avg_loss = (sum(t.net_pnl for t in losses) / len(losses)) if losses else 0.0
    largest_loss = min((t.net_pnl for t in losses), default=0.0)
    avg_hold_candles = (sum(t.hold_candles for t in trades if t.outcome != "open") / closed) if closed else 0.0
    avg_hold_hours = avg_hold_candles * 5.0 / 60.0

    # max drawdown on running equity ($30 pilot capital baseline)
    equity = CAPITAL
    peak = equity
    max_dd = 0.0
    for t in trades:
        if t.outcome == "open":
            continue
        equity += t.net_pnl
        peak = max(peak, equity)
        dd = peak - equity
        if dd > max_dd:
            max_dd = dd

    print(f"\n========== {sym} ==========")
    print(f"trades: {len(trades)}   wins(+$30 tgt): {len(wins)}   losses(BOS stop): {len(losses)}   still-open: {len(opens)}")
    print(f"gross PnL:  ${gross:+.2f}")
    print(f"fees:       ${fees:.2f}   (taker {TAKER_FEE_BPS} bps/side, entry+exit)")
    print(f"slippage:   ${slip:.2f}   (assumed {SLIPPAGE_BPS} bps/side)")
    print(f"funding:    NOT MODELED  (see header)")
    print(f"NET PnL:    ${net:+.2f}   (gross - fees - slippage; funding excluded)")
    print(f"win rate:   {win_rate:.1f}%")
    print(f"avg win:    ${avg_win:+.2f}   avg loss: ${avg_loss:+.2f}   largest loss: ${largest_loss:+.2f}")
    print(f"avg hold:   {avg_hold_candles:.1f} candles ({avg_hold_hours:.2f}h)")
    print(f"max DD on $30 pilot capital: ${max_dd:.2f}")


def main():
    symbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]
    hours = 168
    print("=" * 72)
    print("ACCUMULATOR P&L BACKTEST — owner spec, this session")
    print(f"  leverage={LEVERAGE}x  capital=${CAPITAL}  notional=${NOTIONAL}  margin=${MARGIN}")
    print(f"  target=FLAT +${TARGET_USD} realized (owner override of S39 ladder)")
    print(f"  stop=confirmed BOS on frozen zone edge (reuse of expired_breach edge)")
    print(f"  taker fee={TAKER_FEE_BPS}bps/side  slippage={SLIPPAGE_BPS}bps/side  funding=NOT MODELED")
    print(f"  same-candle priority: STOP before TARGET (worst case)")
    print("=" * 72)

    results = []
    for s in symbols:
        try:
            results.append(run(s, hours))
        except Exception as e:
            print(f"\n[{s}] BLOCKED — real error follows:\n{type(e).__name__}: {e}")
            traceback.print_exc()
            return 2
    for r in results:
        report(r)
    print("\n(see header for every cost/spec assumption)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
