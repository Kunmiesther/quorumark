"""DCA P&L backtest — CORRECTED SIZING, two leverage scenarios (20x vs 100x).

Sizing correction (owner-ratified):
    margin_fraction = notional_constant / leverage = 10 / L   (params sizing)
    tranche_margin  = margin_fraction * CAPITAL
    tranche_notional = tranche_margin * L = 10 * CAPITAL       (invariant of L)
    max_tranches    = floor(CAPITAL / tranche_margin) = L / 10

    A: L=20  -> mf=0.5  margin/tranche=$300  notional/tranche=$6000  cap=2 tranches
    B: L=100 -> mf=0.1  margin/tranche=$60   notional/tranche=$6000  cap=10 tranches

Strategy files untouched. Same 168h ApeX 5m candles feed both scenarios.
Reports worst unrealized drawdown per position (for liquidation check).
Funding NOT modeled.
"""
from __future__ import annotations
import traceback
from dataclasses import dataclass, field
from typing import Optional
import copy

import accumulator_signal as sig
import market_data as md

CAPITAL       = 600.0
TAKER_FEE_BPS = 5.0
SLIPPAGE_BPS  = 2.0
FEE_RATE      = TAKER_FEE_BPS / 10_000.0
SLIP_RATE     = SLIPPAGE_BPS / 10_000.0
TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5


@dataclass
class Tranche:
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
    gross_pnl: float = 0.0
    fees: float = 0.0
    slippage: float = 0.0
    fills: int = 0
    max_tranches_reached: int = 0
    peak_notional: float = 0.0
    final_avg_before_close: float = 0.0
    worst_unrealized_pnl: float = 0.0   # most negative unrealized P&L reached
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


class Scenario:
    def __init__(self, name, leverage):
        self.name = name
        self.L = leverage
        self.margin_fraction = 10.0 / leverage
        self.tranche_margin = self.margin_fraction * CAPITAL
        self.tranche_notional = self.tranche_margin * leverage   # = 10 * CAPITAL
        self.max_tranches = int(CAPITAL // self.tranche_margin)
        self.tp1_move = 2.0 / leverage
        self.tp2_move = 3.0 / leverage
        self.tp3_move = 4.0 / leverage


def apply_fill(pos, qty, price):
    n = qty * price
    pos.fees += n * FEE_RATE
    pos.slippage += n * SLIP_RATE
    pos.fills += 1


def open_tranche(pos, price, zone, sc: Scenario):
    qty = sc.tranche_notional / price
    apply_fill(pos, qty, price)
    pos.tranches.append(Tranche(qty, price, zone.lower, zone.upper))
    if len(pos.tranches) == 1:
        pos.first_vwap = price


def close_qty(pos, qty, price):
    if qty <= 0:
        return
    avg = pos.avg_entry()
    if pos.direction == "long":
        pos.gross_pnl += (price - avg) * qty
    else:
        pos.gross_pnl += (avg - price) * qty
    apply_fill(pos, qty, price)
    remaining = qty
    while remaining > 1e-12 and pos.tranches:
        last = pos.tranches[-1]
        take = min(last.qty, remaining)
        last.qty -= take
        remaining -= take
        if last.qty <= 1e-12:
            pos.tranches.pop()


def tp_targets(pos, sc: Scenario):
    avg = pos.avg_entry()
    if pos.direction == "long":
        return (avg * (1 + sc.tp1_move), avg * (1 + sc.tp2_move),
                pos.first_vwap * (1 + sc.tp3_move))
    return (avg * (1 - sc.tp1_move), avg * (1 - sc.tp2_move),
            pos.first_vwap * (1 - sc.tp3_move))


def unrealized_pnl(pos, price):
    q = pos.total_qty()
    if q <= 0:
        return 0.0
    avg = pos.avg_entry()
    return (price - avg) * q if pos.direction == "long" else (avg - price) * q


def track_extremes(pos, hi, lo):
    q = pos.total_qty()
    if q <= 0:
        return
    # worst intracandle unrealized loss
    adverse = lo if pos.direction == "long" else hi
    upnl = unrealized_pnl(pos, adverse)
    if upnl < pos.worst_unrealized_pnl:
        pos.worst_unrealized_pnl = upnl
    # peak notional exposure (use extreme in position direction)
    fav = hi if pos.direction == "long" else lo
    for px in (fav, adverse):
        n = q * px
        if n > pos.peak_notional:
            pos.peak_notional = n


def simulate(candles, entries_long, entries_short, sc: Scenario):
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
        if entry_i <= cursor:
            continue
        px0 = float(candles[entry_i][CLOSE])
        pos = Position(direction, entry_i, float(candles[entry_i][TS]))
        open_tranche(pos, px0, zone, sc)
        pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
        track_extremes(pos, px0, px0)

        for j in range(entry_i + 1, len(candles)):
            c = candles[j]
            hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])
            track_extremes(pos, hi, lo)

            # 1. stop (armed only after first rebalance)
            if pos.rebalance_done:
                lvl = pos.stop_level()
                if (cl < lvl) if direction == "long" else (cl > lvl):
                    pos.final_avg_before_close = pos.avg_entry()
                    close_qty(pos, pos.total_qty(), cl)
                    pos.exit_i, pos.exit_ts, pos.outcome = j, float(c[TS]), "stop"
                    break

            # 2. rebalance: sell newest tranche at break-even after first resize
            if len(pos.tranches) >= 2 and not pos.rebalance_done:
                be = pos.avg_entry()
                if (hi >= be) if direction == "long" else (lo <= be):
                    close_qty(pos, pos.tranches[-1].qty, be)
                    pos.rebalance_done = True

            # 3. TP ladder
            if pos.total_qty() > 0:
                tp1, tp2, tp3 = tp_targets(pos, sc)
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

            # 4. resize down
            if j in ev_by_i and len(pos.tranches) < sc.max_tranches:
                for d2, z2 in ev_by_i[j]:
                    if d2 != direction:
                        continue
                    last_entry = pos.tranches[-1].entry_px
                    below = cl < last_entry if direction == "long" else cl > last_entry
                    gate_ok = (len(pos.tranches) == 1) or pos.rebalance_done
                    if below and gate_ok:
                        open_tranche(pos, cl, z2, sc)
                        pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
                        # after resize, rebalance flag resets for the NEW newest tranche
                        pos.rebalance_done = False
                        track_extremes(pos, cl, cl)
                        break

        if pos.outcome == "open":
            pos.exit_i = len(candles) - 1
            pos.final_avg_before_close = pos.avg_entry()
        positions.append(pos)
        cursor = pos.exit_i
    return positions


def net_pnl(p): return p.gross_pnl - p.fees - p.slippage


def summarize(positions, sc: Scenario):
    n = len(positions)
    closed = [p for p in positions if p.outcome != "open"]
    tp3s   = [p for p in positions if p.outcome == "tp3_full"]
    stops  = [p for p in positions if p.outcome == "stop"]
    opens  = [p for p in positions if p.outcome == "open"]
    tp_partial_stop = [p for p in stops if p.tp1_done or p.tp2_done]

    max_tr = max((p.max_tranches_reached for p in positions), default=0)
    avg_tr = (sum(p.max_tranches_reached for p in positions) / n) if n else 0.0

    imps = []
    for p in positions:
        if p.first_vwap and p.final_avg_before_close:
            if p.direction == "long":
                imp = (p.first_vwap - p.final_avg_before_close) / p.first_vwap * 100
            else:
                imp = (p.final_avg_before_close - p.first_vwap) / p.first_vwap * 100
            imps.append(imp)
    avg_imp = sum(imps)/len(imps) if imps else 0.0
    max_imp = max(imps) if imps else 0.0

    gross = sum(p.gross_pnl for p in closed)
    fees  = sum(p.fees for p in closed)
    slip  = sum(p.slippage for p in closed)
    net_c = sum(net_pnl(p) for p in closed)
    fills = sum(p.fills for p in closed)

    winners = [p for p in closed if net_pnl(p) > 0]
    losers  = [p for p in closed if net_pnl(p) <= 0]
    win_rate = (len(winners)/len(closed)*100) if closed else 0.0
    avg_win  = (sum(net_pnl(p) for p in winners)/len(winners)) if winners else 0.0
    avg_loss = (sum(net_pnl(p) for p in losers)/len(losers)) if losers else 0.0
    largest_loss = min((net_pnl(p) for p in losers), default=0.0)

    holds = [(p.exit_i - p.open_i) for p in closed]
    avg_hold_c = (sum(holds)/len(holds)) if holds else 0.0

    equity = CAPITAL; peak = equity; max_dd_realized = 0.0
    for p in positions:
        if p.outcome == "open": continue
        equity += net_pnl(p)
        peak = max(peak, equity)
        max_dd_realized = max(max_dd_realized, peak - equity)

    # UNREALIZED worst per position (mid-trade drawdown, relevant for liq)
    worst_unreal = min((p.worst_unrealized_pnl for p in positions), default=0.0)  # most negative
    peak_notional_any = max((p.peak_notional for p in positions), default=0.0)
    avg_peak_notional = (sum(p.peak_notional for p in positions)/n) if n else 0.0

    liquidations = [p for p in positions if -p.worst_unrealized_pnl >= CAPITAL]

    r1 = sum(1 for p in positions if p.tp1_done)
    r2 = sum(1 for p in positions if p.tp2_done)
    r3 = sum(1 for p in positions if p.tp3_done)

    return {
        "n": n, "tp3": len(tp3s), "stops": len(stops), "opens": len(opens),
        "tp_partial_stop": len(tp_partial_stop),
        "avg_tr": avg_tr, "max_tr": max_tr,
        "avg_imp": avg_imp, "max_imp": max_imp,
        "r1": r1, "r2": r2, "r3": r3,
        "gross": gross, "fees": fees, "slip": slip, "net": net_c, "fills": fills,
        "win_rate": win_rate, "avg_win": avg_win, "avg_loss": avg_loss,
        "largest_loss": largest_loss, "avg_hold_c": avg_hold_c,
        "max_dd_realized": max_dd_realized,
        "worst_unrealized": worst_unreal,
        "peak_notional_any": peak_notional_any,
        "avg_peak_notional": avg_peak_notional,
        "liquidations": len(liquidations),
    }


def print_scenario_header(sc: Scenario):
    print("=" * 82)
    print(f"SCENARIO {sc.name}: leverage={sc.L}x  CAPITAL=${CAPITAL:.0f}")
    print(f"  margin_fraction = 10/{sc.L} = {sc.margin_fraction:.3f}")
    print(f"  tranche_margin  = {sc.margin_fraction:.3f} * ${CAPITAL:.0f} = ${sc.tranche_margin:.2f}")
    print(f"  tranche_notional= ${sc.tranche_margin:.2f} * {sc.L} = ${sc.tranche_notional:.2f}")
    print(f"  max_tranches    = floor(${CAPITAL:.0f}/${sc.tranche_margin:.2f}) = {sc.max_tranches}")
    print(f"  TP margin ladder -> price moves: +{sc.tp1_move*100:.2f}% / +{sc.tp2_move*100:.2f}% / +{sc.tp3_move*100:.2f}%")
    print(f"  fees={TAKER_FEE_BPS}bps  slip={SLIPPAGE_BPS}bps  funding=NOT MODELED")
    print("=" * 82)


def print_row(label, val):
    print(f"    {label:<32}{val}")


def report_symbol(sym, s):
    print(f"\n  === {sym} ===")
    print_row("positions opened",             f"{s['n']}")
    print_row("tranches/pos avg | max",       f"{s['avg_tr']:.2f}  |  {s['max_tr']}")
    print_row("avg-entry improvement mean|max", f"{s['avg_imp']:+.3f}% | {s['max_imp']:+.3f}%")
    print_row("TP1 / TP2 / TP3 fires",        f"{s['r1']} / {s['r2']} / {s['r3']}")
    print_row("closes tp3 / tp+stop / stop / open",
              f"{s['tp3']} / {s['tp_partial_stop']} / {s['stops']-s['tp_partial_stop']} / {s['opens']}")
    print_row("gross | fees | slip | NET $",
              f"{s['gross']:+.2f} | {s['fees']:.2f} | {s['slip']:.2f} | {s['net']:+.2f}")
    print_row("total fills",                  f"{s['fills']}")
    print_row("win% | avg win | avg loss | largest loss",
              f"{s['win_rate']:.1f}% | {s['avg_win']:+.2f} | {s['avg_loss']:+.2f} | {s['largest_loss']:+.2f}")
    print_row("avg hold (candles / hours)",   f"{s['avg_hold_c']:.1f} / {s['avg_hold_c']*5/60:.2f}")
    print_row("MAX DD realized (equity curve)", f"${s['max_dd_realized']:.2f} ({s['max_dd_realized']/CAPITAL*100:.1f}% of ${CAPITAL:.0f})")
    print_row("WORST unrealized P&L (mid-trade)",
              f"${s['worst_unrealized']:+.2f}  ({-s['worst_unrealized']/CAPITAL*100:.1f}% of wallet)")
    print_row("PEAK notional exposure (max|avg)",
              f"${s['peak_notional_any']:,.0f} | ${s['avg_peak_notional']:,.0f}")
    print_row("LIQUIDATIONS (unreal loss >= wallet)", f"{s['liquidations']}  {'*** BLOWN ACCOUNT ***' if s['liquidations'] else ''}")


def main():
    symbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]
    hours = 168

    scenarios = [Scenario("A_20x", 20), Scenario("B_100x", 100)]

    # Fetch candles ONCE per symbol -> identical data for both scenarios
    feed = md.ApexPublicFeed()
    data = {}
    for s in symbols:
        try:
            print(f"[{s}] fetching {hours}h of 5m candles via ApeX public klines...")
            f = feed.fetch_range(s, 5, hours=hours)
            longs  = sig.evaluate(f.candles, "long",  f.tick)["entries"]
            shorts = sig.evaluate(f.candles, "short", f.tick)["entries"]
            print(f"[{s}] candles={len(f.candles)}  confirmed retests long={len(longs)} short={len(shorts)}")
            data[s] = (f, longs, shorts)
        except Exception as e:
            print(f"\n[{s}] BLOCKED — real error:\n{type(e).__name__}: {e}")
            traceback.print_exc()
            return 2

    all_summaries: dict[str, dict[str, dict]] = {sc.name: {} for sc in scenarios}
    for sc in scenarios:
        print_scenario_header(sc)
        for s in symbols:
            f, longs, shorts = data[s]
            positions = simulate(f.candles, longs, shorts, sc)
            summary = summarize(positions, sc)
            all_summaries[sc.name][s] = summary
            report_symbol(s, summary)

    # Side-by-side comparison table
    print("\n" + "=" * 82)
    print("SIDE-BY-SIDE (A=20x  vs  B=100x)  --  $600 wallet, same candles")
    print("=" * 82)
    hdr = f"{'symbol':<10}{'metric':<22}{'A (20x)':>18}{'B (100x)':>18}"
    print(hdr); print("-"*len(hdr))
    def row(sym, label, a, b):
        print(f"{sym:<10}{label:<22}{a:>18}{b:>18}")
    for s in symbols:
        A = all_summaries["A_20x"][s]; B = all_summaries["B_100x"][s]
        row(s, "positions",         A['n'], B['n'])
        row("",  "avg tranches",     f"{A['avg_tr']:.2f}", f"{B['avg_tr']:.2f}")
        row("",  "max tranches",     A['max_tr'], B['max_tr'])
        row("",  "avg-entry imp %",  f"{A['avg_imp']:+.3f}", f"{B['avg_imp']:+.3f}")
        row("",  "TP1/TP2/TP3",      f"{A['r1']}/{A['r2']}/{A['r3']}", f"{B['r1']}/{B['r2']}/{B['r3']}")
        row("",  "NET $",            f"{A['net']:+.2f}", f"{B['net']:+.2f}")
        row("",  "worst unreal $",   f"{A['worst_unrealized']:+.2f}", f"{B['worst_unrealized']:+.2f}")
        row("",  "worst unreal %",   f"{-A['worst_unrealized']/CAPITAL*100:.1f}%", f"{-B['worst_unrealized']/CAPITAL*100:.1f}%")
        row("",  "peak notional $",  f"{A['peak_notional_any']:,.0f}", f"{B['peak_notional_any']:,.0f}")
        row("",  "liquidations",     A['liquidations'], B['liquidations'])
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
