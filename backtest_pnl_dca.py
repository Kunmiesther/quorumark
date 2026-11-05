"""FULL DCA P&L backtest — Accumulator per docs/STRATEGY_SPEC_v1.md (v1, ratified).

Corrects backtest_pnl.py, which modeled a single-entry trade with an immediate BOS
stop. That is not the Accumulator. The Accumulator:

  1. Enters at a confirmed retest (5m break-and-retest, close above EMA(15)).
  2. RESIZES DOWN — unbounded (capped only by account capital) — every time
     price makes a new confirmed retest below the last tranche. Average entry
     re-anchors on every add.
  3. STOP DOES NOT EXIST BEFORE THE FIRST REBALANCE. Prior to the first
     resize-then-rebalance, the position rides adverse movement and averages
     down. Once armed, stop trails the most recent resize/retest zone edge,
     confirmed 5m close through it.
  4. Rebalance = after a resize, sell the newest tranche when price returns to
     break-even (the current average entry).
  5. TP ladder is MARGIN-based against CURRENT average entry:
        TP1 +200% margin ROI  -> sell half              (price move 200%/L)
        TP2 +300% margin ROI  -> sell half of remainder (price move 300%/L)
        TP3 400% margin ROI on the FROZEN first-fill VWAP -> full close (S39).
     At L=20x these are +10% / +15% / +20% price moves from the relevant anchor.

STRATEGY FILES ARE NOT MODIFIED. This script IMPORTS accumulator_signal.evaluate
and reuses its RetestResult zones for both entries and BOS stops.

DATA: ApeX Omni public 5m klines, 168h. Reports honest "blocked" on fetch failure.

COSTS printed in the header. Every fill (each tranche entry, each partial exit,
rebalance, stop) pays taker fee + slippage. Funding NOT modeled.
"""
from __future__ import annotations

import sys, traceback
from dataclasses import dataclass, field
from typing import Optional

import accumulator_signal as sig
import market_data as md

# ---------------- spec / cost constants (printed) ----------------
LEVERAGE       = 20
CAPITAL        = 30.0                  # $ pilot canary baseline
NOTIONAL_TRANCHE = CAPITAL * 10        # $300 per tranche (sizing.notional_constant=10)
MARGIN_TRANCHE = NOTIONAL_TRANCHE / LEVERAGE   # $15
MAX_TRANCHES   = int(CAPITAL // MARGIN_TRANCHE)  # cap: sum(margin) <= capital -> 2

TP1_PRICE_MOVE = 2.0 / LEVERAGE        # 200% margin / L = 0.10 at 20x
TP2_PRICE_MOVE = 3.0 / LEVERAGE        # 300% margin / L = 0.15
TP3_PRICE_MOVE = 4.0 / LEVERAGE        # 400% margin / L = 0.20  (S39)

TAKER_FEE_BPS  = 5.0                   # ApeX Omni taker 0.05%
SLIPPAGE_BPS   = 2.0                   # symmetric assumption
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
    first_vwap: float = 0.0            # FROZEN at first fill for TP3 (S39)
    rebalance_done: bool = False       # arms stop
    tp1_done: bool = False
    tp2_done: bool = False
    tp3_done: bool = False
    last_resize_i: Optional[int] = None
    # accounting
    gross_pnl: float = 0.0
    fees: float = 0.0
    slippage: float = 0.0
    fills: int = 0
    max_tranches_reached: int = 0
    exit_i: Optional[int] = None
    exit_ts: Optional[float] = None
    outcome: str = "open"              # tp3_full | stop | open

    def total_qty(self) -> float:
        return sum(t.qty for t in self.tranches)

    def avg_entry(self) -> float:
        q = self.total_qty()
        if q <= 0: return 0.0
        return sum(t.qty * t.entry_px for t in self.tranches) / q

    def stop_level(self) -> float:
        # most recent resize/retest zone edge (trailing)
        t = self.tranches[-1]
        return t.zone_lower if self.direction == "long" else t.zone_upper


def _apply_fill(pos: Position, qty: float, price: float, sign: str) -> float:
    """sign='open' adds notional, 'close' realizes P&L on a chunk of qty."""
    notional = qty * price
    pos.fees += notional * FEE_RATE
    pos.slippage += notional * SLIP_RATE
    pos.fills += 1
    return notional


def open_tranche(pos: Position, i: int, price: float, zone) -> None:
    qty = NOTIONAL_TRANCHE / price
    _apply_fill(pos, qty, price, "open")
    pos.tranches.append(Tranche(len(pos.tranches), qty, price, zone.lower, zone.upper))
    if len(pos.tranches) == 1:
        pos.first_vwap = price
    else:
        pos.last_resize_i = i


def close_qty(pos: Position, qty: float, price: float) -> None:
    if qty <= 0: return
    # realize P&L for `qty` at avg entry
    avg = pos.avg_entry()
    if pos.direction == "long":
        pos.gross_pnl += (price - avg) * qty
    else:
        pos.gross_pnl += (avg - price) * qty
    _apply_fill(pos, qty, price, "close")
    # remove qty from tranches (LIFO for "sell newest at BE"; proportional otherwise)
    remaining = qty
    while remaining > 1e-12 and pos.tranches:
        last = pos.tranches[-1]
        take = min(last.qty, remaining)
        last.qty -= take
        remaining -= take
        if last.qty <= 1e-12:
            pos.tranches.pop()


def tp_targets(pos: Position) -> tuple[float, float, float]:
    avg = pos.avg_entry()
    if pos.direction == "long":
        return (avg * (1 + TP1_PRICE_MOVE),
                avg * (1 + TP2_PRICE_MOVE),
                pos.first_vwap * (1 + TP3_PRICE_MOVE))
    return (avg * (1 - TP1_PRICE_MOVE),
            avg * (1 - TP2_PRICE_MOVE),
            pos.first_vwap * (1 - TP3_PRICE_MOVE))


def simulate(candles, entries_long, entries_short) -> list[Position]:
    # merge signals by index; carry direction and zone
    evs = []
    for r in entries_long:
        evs.append((r.retest_index, "long", r.break_event.zone))
    for r in entries_short:
        evs.append((r.retest_index, "short", r.break_event.zone))
    evs.sort(key=lambda x: x[0])

    # index -> list of (direction, zone) for O(1) lookahead
    ev_by_i: dict[int, list[tuple[str, object]]] = {}
    for i, d, z in evs:
        ev_by_i.setdefault(i, []).append((d, z))

    positions: list[Position] = []
    cursor = -1
    for entry_i, direction, zone in evs:
        if entry_i <= cursor:
            continue
        px0 = float(candles[entry_i][CLOSE])
        pos = Position(direction, entry_i, float(candles[entry_i][TS]))
        open_tranche(pos, entry_i, px0, zone)
        pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))

        for j in range(entry_i + 1, len(candles)):
            c = candles[j]
            hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])

            # ---- STOP (only if armed by first rebalance) ---------------
            if pos.rebalance_done:
                lvl = pos.stop_level()
                stop_hit = (cl < lvl) if direction == "long" else (cl > lvl)
                if stop_hit:
                    close_qty(pos, pos.total_qty(), cl)
                    pos.exit_i, pos.exit_ts, pos.outcome = j, float(c[TS]), "stop"
                    break

            # ---- REBALANCE at break-even (sell newest tranche) ---------
            if len(pos.tranches) >= 2 and not pos.rebalance_done:
                be = pos.avg_entry()
                be_hit = (hi >= be) if direction == "long" else (lo <= be)
                if be_hit:
                    close_qty(pos, pos.tranches[-1].qty, be)
                    pos.rebalance_done = True  # arms stop
                    # after rebalance the last tranche is gone; stop trails to
                    # the remaining latest tranche/retest zone (already correct
                    # because tranches[-1] is now that one)

            # ---- TAKE PROFIT LADDER ------------------------------------
            if pos.total_qty() > 0:
                tp1, tp2, tp3 = tp_targets(pos)
                if not pos.tp1_done:
                    hit = (hi >= tp1) if direction == "long" else (lo <= tp1)
                    if hit:
                        close_qty(pos, pos.total_qty() * 0.5, tp1)
                        pos.tp1_done = True
                if pos.tp1_done and not pos.tp2_done and pos.total_qty() > 0:
                    hit = (hi >= tp2) if direction == "long" else (lo <= tp2)
                    if hit:
                        close_qty(pos, pos.total_qty() * 0.5, tp2)
                        pos.tp2_done = True
                if pos.tp2_done and not pos.tp3_done and pos.total_qty() > 0:
                    hit = (hi >= tp3) if direction == "long" else (lo <= tp3)
                    if hit:
                        close_qty(pos, pos.total_qty(), tp3)
                        pos.tp3_done = True
                        pos.exit_i, pos.exit_ts, pos.outcome = j, float(c[TS]), "tp3_full"
                        break

            # ---- RESIZE DOWN on new confirmed retest -------------------
            if j in ev_by_i and len(pos.tranches) < MAX_TRANCHES:
                for d2, z2 in ev_by_i[j]:
                    if d2 != direction:
                        continue
                    last_entry = pos.tranches[-1].entry_px
                    below = float(c[CLOSE]) < last_entry if direction == "long" else float(c[CLOSE]) > last_entry
                    # first resize has no prior_rebalance gate; further resizes require it
                    gate_ok = (len(pos.tranches) == 1) or pos.rebalance_done
                    if below and gate_ok:
                        open_tranche(pos, j, float(c[CLOSE]), z2)
                        pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
                        break

        if pos.outcome == "open":
            pos.exit_i = len(candles) - 1
        positions.append(pos)
        cursor = pos.exit_i
    return positions


def run(symbol: str, hours: int) -> dict:
    feed = md.ApexPublicFeed()
    print(f"[{symbol}] fetching {hours}h of 5m candles via ApeX public klines...")
    f = feed.fetch_range(symbol, 5, hours=hours)
    c = f.candles
    print(f"[{symbol}] candles={len(c)} span={(len(c)*5)/60:.1f}h age_sec={f.age_sec:.1f}")

    longs = sig.evaluate(c, "long",  f.tick)["entries"]
    shorts = sig.evaluate(c, "short", f.tick)["entries"]
    print(f"[{symbol}] confirmed retests: long={len(longs)} short={len(shorts)}")

    positions = simulate(c, longs, shorts)
    return {"symbol": symbol, "candles": c, "positions": positions}


def net_pnl(p: Position) -> float:
    return p.gross_pnl - p.fees - p.slippage


def report(res: dict) -> None:
    sym = res["symbol"]; positions: list[Position] = res["positions"]; candles = res["candles"]

    n = len(positions)
    tp3s = [p for p in positions if p.outcome == "tp3_full"]
    stops = [p for p in positions if p.outcome == "stop"]
    opens = [p for p in positions if p.outcome == "open"]

    avg_tranches = (sum(p.max_tranches_reached for p in positions) / n) if n else 0.0

    closed = [p for p in positions if p.outcome != "open"]
    gross = sum(p.gross_pnl for p in closed)
    fees = sum(p.fees for p in closed)
    slip = sum(p.slippage for p in closed)
    net = sum(net_pnl(p) for p in closed)
    fills = sum(p.fills for p in closed)

    winners = [p for p in closed if net_pnl(p) > 0]
    losers  = [p for p in closed if net_pnl(p) <= 0]
    win_rate = (len(winners) / len(closed) * 100) if closed else 0.0
    avg_win = (sum(net_pnl(p) for p in winners) / len(winners)) if winners else 0.0
    avg_loss = (sum(net_pnl(p) for p in losers) / len(losers)) if losers else 0.0
    largest_loss = min((net_pnl(p) for p in losers), default=0.0)

    holds = [(p.exit_i - p.open_i) for p in closed]
    avg_hold_c = (sum(holds)/len(holds)) if holds else 0.0
    avg_hold_h = avg_hold_c * 5 / 60.0

    equity = CAPITAL; peak = equity; max_dd = 0.0
    for p in positions:
        if p.outcome == "open": continue
        equity += net_pnl(p)
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)

    # ladder rung counts
    r1 = sum(1 for p in positions if p.tp1_done)
    r2 = sum(1 for p in positions if p.tp2_done)
    r3 = sum(1 for p in positions if p.tp3_done)
    rebals = sum(1 for p in positions if p.rebalance_done)

    print(f"\n========== {sym} ==========")
    print(f"positions opened:      {n}   (one-at-a-time)")
    print(f"avg tranches/position: {avg_tranches:.2f}   (max {MAX_TRANCHES} by capital cap)")
    print(f"rebalances filled:     {rebals}   -> stop armed on those positions")
    print(f"outcomes: tp3_full={len(tp3s)}  stop={len(stops)}  open_at_end={len(opens)}")
    print(f"ladder fires: TP1(+200% margin)={r1}  TP2(+300%)={r2}  TP3(frozen first-vwap +400%)={r3}")
    print(f"total fills:  {fills}   (fee+slippage paid on each — tranche entries, rebalances, partial/full exits)")
    print(f"gross PnL:    ${gross:+.2f}")
    print(f"fees:         ${fees:.2f}   (taker {TAKER_FEE_BPS} bps/fill)")
    print(f"slippage:     ${slip:.2f}   (assumed {SLIPPAGE_BPS} bps/fill)")
    print(f"funding:      NOT MODELED")
    print(f"NET PnL:      ${net:+.2f}")
    print(f"win rate:     {win_rate:.1f}%   avg win: ${avg_win:+.2f}   avg loss: ${avg_loss:+.2f}   largest loss: ${largest_loss:+.2f}")
    print(f"avg hold:     {avg_hold_c:.1f} candles ({avg_hold_h:.2f}h)")
    print(f"max DD on ${CAPITAL:.0f} capital: ${max_dd:.2f}")


def main():
    symbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]
    hours = 168
    print("=" * 78)
    print("ACCUMULATOR DCA P&L BACKTEST — v1 ratified spec")
    print(f"  leverage={LEVERAGE}x  cross futures  ApeX Omni")
    print(f"  capital=${CAPITAL}  notional/tranche=${NOTIONAL_TRANCHE}  margin/tranche=${MARGIN_TRANCHE}")
    print(f"  max tranches by capital cap = {MAX_TRANCHES}  (position_margin <= account_capital)")
    print(f"  TP ladder (margin basis vs current avg): +200%/+300% price moves = {TP1_PRICE_MOVE*100:.1f}%/{TP2_PRICE_MOVE*100:.1f}% at {LEVERAGE}x")
    print(f"  TP3 anchor = FROZEN first-fill VWAP + {TP3_PRICE_MOVE*100:.1f}% price move (S39)")
    print(f"  stop ARMS only after first rebalance; trails most recent resize/retest zone edge (confirmed 5m close)")
    print(f"  rebalance rule: after resize, sell newest tranche at avg-entry break-even")
    print(f"  taker fee={TAKER_FEE_BPS}bps/fill  slippage={SLIPPAGE_BPS}bps/fill  funding=NOT MODELED")
    print(f"  same-candle priority: STOP > REBALANCE > TP > RESIZE (worst case for stop, correctness for others)")
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
