"""$600 capital re-run of backtest_pnl_dca.py — SAME strategy, ONE change: CAPITAL 30->600.

Rationale (owner): at canary $30 with $15 margin/tranche the account cap allowed only 2
tranches, so the unbounded average-down never actually ran. $600 at $15 margin/tranche
allows ~40 tranches — the strategy's real intended operating size. Tranche size itself
(canary $300 notional / $15 margin) is UNCHANGED. Only the account capital cap moves.

STRATEGY FILES ARE NOT MODIFIED. Imports accumulator_signal.evaluate. Real ApeX data.
Adds: per-position peak notional exposure, avg-entry improvement %, portfolio peak
notional across the run.
"""
from __future__ import annotations
import traceback
from dataclasses import dataclass, field
from typing import Optional

import accumulator_signal as sig
import market_data as md

# ---- spec / cost constants ------------------------------------------------
LEVERAGE          = 20
CAPITAL           = 600.0                 # <<< owner real op size (was 30 canary)
NOTIONAL_TRANCHE  = 300.0                 # canary tranche size, unchanged
MARGIN_TRANCHE    = NOTIONAL_TRANCHE / LEVERAGE           # $15
MAX_TRANCHES      = int(CAPITAL // MARGIN_TRANCHE)        # 600/15 = 40

TP1_PRICE_MOVE = 2.0 / LEVERAGE
TP2_PRICE_MOVE = 3.0 / LEVERAGE
TP3_PRICE_MOVE = 4.0 / LEVERAGE

TAKER_FEE_BPS  = 5.0
SLIPPAGE_BPS   = 2.0
FEE_RATE  = TAKER_FEE_BPS / 10_000.0
SLIP_RATE = SLIPPAGE_BPS / 10_000.0

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5


@dataclass
class Tranche:
    idx: int
    qty: float
    entry_px: float
    zone_lower: float
    zone_upper: float


@dataclass
class Position:
    direction: str
    open_i: int
    open_ts: float
    tranches: list[Tranche] = field(default_factory=list)
    first_vwap: float = 0.0
    rebalance_done: bool = False
    tp1_done: bool = False
    tp2_done: bool = False
    tp3_done: bool = False
    last_resize_i: Optional[int] = None
    gross_pnl: float = 0.0
    fees: float = 0.0
    slippage: float = 0.0
    fills: int = 0
    max_tranches_reached: int = 0
    peak_notional: float = 0.0
    avg_at_peak: float = 0.0
    final_avg_before_close: float = 0.0
    exit_i: Optional[int] = None
    exit_ts: Optional[float] = None
    outcome: str = "open"

    def total_qty(self) -> float:
        return sum(t.qty for t in self.tranches)

    def avg_entry(self) -> float:
        q = self.total_qty()
        return sum(t.qty * t.entry_px for t in self.tranches) / q if q > 0 else 0.0

    def stop_level(self) -> float:
        t = self.tranches[-1]
        return t.zone_lower if self.direction == "long" else t.zone_upper


def _apply_fill(pos, qty, price):
    n = qty * price
    pos.fees += n * FEE_RATE
    pos.slippage += n * SLIP_RATE
    pos.fills += 1


def open_tranche(pos, i, price, zone):
    qty = NOTIONAL_TRANCHE / price
    _apply_fill(pos, qty, price)
    pos.tranches.append(Tranche(len(pos.tranches), qty, price, zone.lower, zone.upper))
    if len(pos.tranches) == 1:
        pos.first_vwap = price
    else:
        pos.last_resize_i = i


def close_qty(pos, qty, price):
    if qty <= 0: return
    avg = pos.avg_entry()
    if pos.direction == "long":
        pos.gross_pnl += (price - avg) * qty
    else:
        pos.gross_pnl += (avg - price) * qty
    _apply_fill(pos, qty, price)
    remaining = qty
    while remaining > 1e-12 and pos.tranches:
        last = pos.tranches[-1]
        take = min(last.qty, remaining)
        last.qty -= take
        remaining -= take
        if last.qty <= 1e-12:
            pos.tranches.pop()


def tp_targets(pos):
    avg = pos.avg_entry()
    if pos.direction == "long":
        return (avg * (1 + TP1_PRICE_MOVE), avg * (1 + TP2_PRICE_MOVE),
                pos.first_vwap * (1 + TP3_PRICE_MOVE))
    return (avg * (1 - TP1_PRICE_MOVE), avg * (1 - TP2_PRICE_MOVE),
            pos.first_vwap * (1 - TP3_PRICE_MOVE))


def track_peak(pos, price):
    notional = pos.total_qty() * price
    if notional > pos.peak_notional:
        pos.peak_notional = notional
        pos.avg_at_peak = pos.avg_entry()


def simulate(candles, entries_long, entries_short):
    evs = []
    for r in entries_long:  evs.append((r.retest_index, "long",  r.break_event.zone))
    for r in entries_short: evs.append((r.retest_index, "short", r.break_event.zone))
    evs.sort(key=lambda x: x[0])
    ev_by_i: dict[int, list] = {}
    for i, d, z in evs:
        ev_by_i.setdefault(i, []).append((d, z))

    positions: list[Position] = []
    cursor = -1
    for entry_i, direction, zone in evs:
        if entry_i <= cursor: continue
        px0 = float(candles[entry_i][CLOSE])
        pos = Position(direction, entry_i, float(candles[entry_i][TS]))
        open_tranche(pos, entry_i, px0, zone)
        pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
        track_peak(pos, px0)

        for j in range(entry_i + 1, len(candles)):
            c = candles[j]
            hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])
            track_peak(pos, cl)

            if pos.rebalance_done:
                lvl = pos.stop_level()
                if (cl < lvl) if direction == "long" else (cl > lvl):
                    pos.final_avg_before_close = pos.avg_entry()
                    close_qty(pos, pos.total_qty(), cl)
                    pos.exit_i, pos.exit_ts, pos.outcome = j, float(c[TS]), "stop"
                    break

            if len(pos.tranches) >= 2 and not pos.rebalance_done:
                be = pos.avg_entry()
                if (hi >= be) if direction == "long" else (lo <= be):
                    close_qty(pos, pos.tranches[-1].qty, be)
                    pos.rebalance_done = True

            if pos.total_qty() > 0:
                tp1, tp2, tp3 = tp_targets(pos)
                if not pos.tp1_done:
                    if (hi >= tp1) if direction == "long" else (lo <= tp1):
                        close_qty(pos, pos.total_qty() * 0.5, tp1); pos.tp1_done = True
                if pos.tp1_done and not pos.tp2_done and pos.total_qty() > 0:
                    if (hi >= tp2) if direction == "long" else (lo <= tp2):
                        close_qty(pos, pos.total_qty() * 0.5, tp2); pos.tp2_done = True
                if pos.tp2_done and not pos.tp3_done and pos.total_qty() > 0:
                    if (hi >= tp3) if direction == "long" else (lo <= tp3):
                        pos.final_avg_before_close = pos.avg_entry()
                        close_qty(pos, pos.total_qty(), tp3)
                        pos.tp3_done = True
                        pos.exit_i, pos.exit_ts, pos.outcome = j, float(c[TS]), "tp3_full"
                        break

            if j in ev_by_i and len(pos.tranches) < MAX_TRANCHES:
                for d2, z2 in ev_by_i[j]:
                    if d2 != direction: continue
                    last_entry = pos.tranches[-1].entry_px
                    below = cl < last_entry if direction == "long" else cl > last_entry
                    gate_ok = (len(pos.tranches) == 1) or pos.rebalance_done
                    if below and gate_ok:
                        open_tranche(pos, j, cl, z2)
                        pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
                        track_peak(pos, cl)
                        break

        if pos.outcome == "open":
            pos.exit_i = len(candles) - 1
            pos.final_avg_before_close = pos.avg_entry()
        positions.append(pos)
        cursor = pos.exit_i
    return positions


def run(symbol, hours):
    feed = md.ApexPublicFeed()
    print(f"[{symbol}] fetching {hours}h of 5m candles via ApeX public klines...")
    f = feed.fetch_range(symbol, 5, hours=hours)
    c = f.candles
    print(f"[{symbol}] candles={len(c)} span={(len(c)*5)/60:.1f}h age_sec={f.age_sec:.1f}")
    longs  = sig.evaluate(c, "long",  f.tick)["entries"]
    shorts = sig.evaluate(c, "short", f.tick)["entries"]
    print(f"[{symbol}] confirmed retests: long={len(longs)} short={len(shorts)}")
    positions = simulate(c, longs, shorts)
    return {"symbol": symbol, "candles": c, "positions": positions}


def net_pnl(p): return p.gross_pnl - p.fees - p.slippage


def report(res):
    sym = res["symbol"]; positions: list[Position] = res["positions"]
    n = len(positions)
    tp3s   = [p for p in positions if p.outcome == "tp3_full"]
    stops  = [p for p in positions if p.outcome == "stop"]
    opens  = [p for p in positions if p.outcome == "open"]

    max_tr = max((p.max_tranches_reached for p in positions), default=0)
    avg_tr = (sum(p.max_tranches_reached for p in positions) / n) if n else 0.0

    # avg improvement: (first_vwap -> final avg before close) as a % of first
    improvements = []
    for p in positions:
        if p.first_vwap and p.final_avg_before_close:
            if p.direction == "long":
                imp = (p.first_vwap - p.final_avg_before_close) / p.first_vwap * 100
            else:
                imp = (p.final_avg_before_close - p.first_vwap) / p.first_vwap * 100
            improvements.append(imp)
    avg_imp = sum(improvements)/len(improvements) if improvements else 0.0
    max_imp = max(improvements) if improvements else 0.0

    peak_notional_any = max((p.peak_notional for p in positions), default=0.0)
    avg_peak_notional = (sum(p.peak_notional for p in positions)/n) if n else 0.0

    closed = [p for p in positions if p.outcome != "open"]
    gross = sum(p.gross_pnl for p in closed)
    fees  = sum(p.fees for p in closed)
    slip  = sum(p.slippage for p in closed)
    net   = sum(net_pnl(p) for p in closed)
    fills = sum(p.fills for p in closed)

    winners = [p for p in closed if net_pnl(p) > 0]
    losers  = [p for p in closed if net_pnl(p) <= 0]
    win_rate = (len(winners)/len(closed)*100) if closed else 0.0
    avg_win  = (sum(net_pnl(p) for p in winners)/len(winners)) if winners else 0.0
    avg_loss = (sum(net_pnl(p) for p in losers)/len(losers)) if losers else 0.0
    largest_loss = min((net_pnl(p) for p in losers), default=0.0)

    holds = [(p.exit_i - p.open_i) for p in closed]
    avg_hold_c = (sum(holds)/len(holds)) if holds else 0.0

    equity = CAPITAL; peak = equity; max_dd = 0.0
    for p in positions:
        if p.outcome == "open": continue
        equity += net_pnl(p)
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)

    r1 = sum(1 for p in positions if p.tp1_done)
    r2 = sum(1 for p in positions if p.tp2_done)
    r3 = sum(1 for p in positions if p.tp3_done)
    rebals = sum(1 for p in positions if p.rebalance_done)

    print(f"\n========== {sym} ==========")
    print(f"positions opened:      {n}")
    print(f"tranches/position:     avg={avg_tr:.2f}  max_reached={max_tr}  (cap={MAX_TRANCHES})")
    print(f"avg-entry improvement: mean={avg_imp:+.3f}%  best={max_imp:+.3f}%   (first_vwap -> final avg)")
    print(f"peak notional expo:    per-position max=${peak_notional_any:,.0f}  avg=${avg_peak_notional:,.0f}   (capital*L cap = ${CAPITAL*LEVERAGE:,.0f})")
    print(f"rebalances filled:     {rebals}   -> stop armed on those")
    print(f"outcomes: tp3_full={len(tp3s)}  stop={len(stops)}  open_at_end={len(opens)}")
    print(f"ladder fires: TP1={r1}  TP2={r2}  TP3={r3}")
    print(f"total fills:  {fills}   (fee+slip on each)")
    print(f"gross PnL:    ${gross:+.2f}")
    print(f"fees:         ${fees:.2f}   ({TAKER_FEE_BPS}bps/fill)")
    print(f"slippage:     ${slip:.2f}   ({SLIPPAGE_BPS}bps/fill)")
    print(f"funding:      NOT MODELED")
    print(f"NET PnL:      ${net:+.2f}")
    print(f"win rate:     {win_rate:.1f}%   avg win: ${avg_win:+.2f}   avg loss: ${avg_loss:+.2f}   largest loss: ${largest_loss:+.2f}")
    print(f"avg hold:     {avg_hold_c:.1f} candles ({avg_hold_c*5/60:.2f}h)")
    print(f"MAX DD on ${CAPITAL:.0f} capital: ${max_dd:.2f}   ({max_dd/CAPITAL*100:.1f}% of capital)")


def main():
    symbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]
    hours = 168
    print("=" * 78)
    print("ACCUMULATOR DCA P&L BACKTEST — $600 REAL-SIZE RUN (v1 ratified spec)")
    print(f"  leverage={LEVERAGE}x  cross futures  ApeX Omni")
    print(f"  CAPITAL=${CAPITAL}  notional/tranche=${NOTIONAL_TRANCHE}  margin/tranche=${MARGIN_TRANCHE}")
    print(f"  MAX TRANCHES by capital cap = {MAX_TRANCHES}   (was 2 at $30 canary)")
    print(f"  TP ladder margin-basis vs current avg: +200%/+300% = {TP1_PRICE_MOVE*100:.1f}%/{TP2_PRICE_MOVE*100:.1f}% price at {LEVERAGE}x")
    print(f"  TP3 = FROZEN first-fill VWAP +{TP3_PRICE_MOVE*100:.1f}% (S39)")
    print(f"  stop arms only after first rebalance; trails latest resize/retest zone edge")
    print(f"  taker={TAKER_FEE_BPS}bps  slip={SLIPPAGE_BPS}bps  funding=NOT MODELED")
    print(f"  priority: STOP > REBALANCE > TP > RESIZE")
    print("=" * 78)
    results = []
    for s in symbols:
        try:
            results.append(run(s, hours))
        except Exception as e:
            print(f"\n[{s}] BLOCKED — real error:\n{type(e).__name__}: {e}")
            traceback.print_exc()
            return 2
    for r in results:
        report(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
