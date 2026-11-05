"""DCA P&L backtest — CORRECTED SPEC (owner-ratified this session).

Wallet=$600. Leverage 100x on BTC/ETH, 50x on SOL (ApeX venue cap for SOL).
Sizing: margin_fraction = 10/leverage → tranche_margin, tranche_notional invariant of L.
Max 5 tranches/campaign. DCA adds a tranche only at a NEW confirmed retest at
a lower price (long) / higher price (short) than the last filled tranche.
TP: at +50% margin ROI on BLENDED avg entry, laddered 50/30/20:
    rung1 sells 50% at +50% margin ROI move from avg
    rung2 sells 30% at +55% margin ROI (just beyond)
    rung3 sells last 20% at +60% margin ROI
    (Owner said "at/just beyond the +50% margin target"; documented ladder.)
HARD STOP: account equity (wallet + realized + unrealized on open pos) <= $500
    → flatten entire position. This is the ONLY exit besides TP ladder.
Costs: taker 5bps + slip 2bps every fill. Funding NOT modeled.
Strategy files untouched.
"""
from __future__ import annotations
import traceback
from dataclasses import dataclass, field
from typing import Optional

import accumulator_signal as sig
import market_data as md

WALLET_START     = 600.0
HARD_FLOOR       = 500.0
MAX_TRANCHES     = 5
TAKER_FEE_BPS    = 5.0
SLIPPAGE_BPS     = 2.0
FEE_RATE         = TAKER_FEE_BPS / 10_000.0
SLIP_RATE        = SLIPPAGE_BPS / 10_000.0
NOTIONAL_CONST   = 10.0     # params sizing constant
TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

# TP ladder in margin-ROI %; at leverage L, price move = pct/100 / L
TP_LADDER = [(0.50, 0.50), (0.30, 0.55), (0.20, 0.60)]  # (fraction_of_original_qty, margin_roi)


@dataclass
class Tranche:
    qty: float
    entry_px: float


@dataclass
class Campaign:
    direction: str
    open_i: int
    open_ts: float
    tranches: list[Tranche] = field(default_factory=list)
    last_entry_px: float = 0.0
    original_total_qty: float = 0.0
    rung_done: list[bool] = field(default_factory=lambda: [False, False, False])
    gross_pnl: float = 0.0
    fees: float = 0.0
    slippage: float = 0.0
    fills: int = 0
    max_tranches_reached: int = 0
    peak_notional: float = 0.0
    worst_unrealized_pnl: float = 0.0
    exit_i: Optional[int] = None
    exit_ts: Optional[float] = None
    outcome: str = "open"

    def total_qty(self) -> float:
        return sum(t.qty for t in self.tranches)

    def avg_entry(self) -> float:
        q = self.total_qty()
        return sum(t.qty * t.entry_px for t in self.tranches) / q if q > 0 else 0.0


def unrealized(pos: Campaign, price: float) -> float:
    q = pos.total_qty()
    if q <= 0:
        return 0.0
    avg = pos.avg_entry()
    return (price - avg) * q if pos.direction == "long" else (avg - price) * q


def tp_price(avg: float, direction: str, margin_roi: float, leverage: float) -> float:
    move = margin_roi / leverage
    return avg * (1 + move) if direction == "long" else avg * (1 - move)


def apply_fill(pos: Campaign, qty: float, price: float) -> None:
    n = qty * price
    pos.fees += n * FEE_RATE
    pos.slippage += n * SLIP_RATE
    pos.fills += 1


def open_tranche(pos: Campaign, price: float, tranche_notional: float) -> None:
    qty = tranche_notional / price
    apply_fill(pos, qty, price)
    pos.tranches.append(Tranche(qty, price))
    pos.last_entry_px = price


def close_qty(pos: Campaign, qty: float, price: float) -> None:
    if qty <= 0 or pos.total_qty() <= 0:
        return
    qty = min(qty, pos.total_qty())
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


def track_extremes(pos: Campaign, hi: float, lo: float) -> None:
    q = pos.total_qty()
    if q <= 0:
        return
    adverse = lo if pos.direction == "long" else hi
    upnl = unrealized(pos, adverse)
    if upnl < pos.worst_unrealized_pnl:
        pos.worst_unrealized_pnl = upnl
    for px in (hi, lo):
        n = q * px
        if n > pos.peak_notional:
            pos.peak_notional = n


def simulate(candles, entries_long, entries_short, leverage: float):
    margin_fraction = NOTIONAL_CONST / leverage
    # tranche margin is fraction of WALLET (per corrected sizing established prior turn)
    tranche_margin = margin_fraction * WALLET_START
    tranche_notional = tranche_margin * leverage  # = NOTIONAL_CONST * WALLET_START

    evs = []
    for r in entries_long:  evs.append((r.retest_index, "long",  float(candles[r.retest_index][CLOSE])))
    for r in entries_short: evs.append((r.retest_index, "short", float(candles[r.retest_index][CLOSE])))
    evs.sort(key=lambda x: x[0])
    ev_by_i: dict[int, list] = {}
    for i, d, px in evs:
        ev_by_i.setdefault(i, []).append((d, px))

    wallet = WALLET_START
    campaigns: list[Campaign] = []
    cursor = -1

    for entry_i, direction, _px in evs:
        if entry_i <= cursor:
            continue
        if wallet <= HARD_FLOOR:
            break  # spec: wallet at/below floor halts trading

        px0 = float(candles[entry_i][CLOSE])
        pos = Campaign(direction, entry_i, float(candles[entry_i][TS]))

        open_tranche(pos, px0, tranche_notional)
        pos.max_tranches_reached = 1
        track_extremes(pos, px0, px0)

        for j in range(entry_i + 1, len(candles)):
            c = candles[j]
            hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])
            track_extremes(pos, hi, lo)

            # 1. HARD STOP — account equity floor. Trigger fills at the price where
            # equity crosses FLOOR, not the candle extreme (approximates a stop-market).
            adverse = lo if direction == "long" else hi
            equity_adverse = wallet + pos.gross_pnl - pos.fees - pos.slippage + unrealized(pos, adverse)
            if equity_adverse <= HARD_FLOOR:
                base = wallet + pos.gross_pnl - pos.fees - pos.slippage
                q = pos.total_qty(); avg = pos.avg_entry()
                unreal_needed = HARD_FLOOR - base
                if q > 0:
                    if direction == "long":
                        trig_px = avg + unreal_needed / q
                    else:
                        trig_px = avg - unreal_needed / q
                    # clamp into candle range (should already be, but safety)
                    trig_px = max(lo, min(hi, trig_px))
                else:
                    trig_px = cl
                close_qty(pos, pos.total_qty(), trig_px)
                pos.exit_i, pos.exit_ts, pos.outcome = j, float(c[TS]), "hard_floor"
                break


            # 2. TP ladder — rung fires when price crosses target derived from CURRENT avg
            if pos.total_qty() > 0 and pos.original_total_qty == 0:
                # lock 'original' at first TP evaluation? We need a reference for 50/30/20 fractions.
                pass
            # We compute rung targets based on CURRENT avg each candle, but rung fractions are of ORIGINAL qty at time of first TP fire
            for k, (frac, roi) in enumerate(TP_LADDER):
                if pos.rung_done[k] or pos.total_qty() <= 0:
                    continue
                avg = pos.avg_entry()
                tgt = tp_price(avg, direction, roi, leverage)
                hit = (hi >= tgt) if direction == "long" else (lo <= tgt)
                if hit:
                    if pos.original_total_qty == 0:
                        pos.original_total_qty = pos.total_qty()
                    sell_qty = pos.original_total_qty * frac
                    close_qty(pos, sell_qty, tgt)
                    pos.rung_done[k] = True
                    if all(pos.rung_done) or pos.total_qty() <= 1e-9:
                        pos.exit_i, pos.exit_ts, pos.outcome = j, float(c[TS]), "tp_full"
                        break
            if pos.outcome != "open":
                break

            # 3. DCA — add tranche at new confirmed retest, only lower(long)/higher(short), cap 5
            if j in ev_by_i and len(pos.tranches) < MAX_TRANCHES:
                for d2, px2 in ev_by_i[j]:
                    if d2 != direction:
                        continue
                    better = (px2 < pos.last_entry_px) if direction == "long" else (px2 > pos.last_entry_px)
                    if better:
                        open_tranche(pos, px2, tranche_notional)
                        pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
                        # reset original_total_qty since position size changed pre-TP
                        if not any(pos.rung_done):
                            pos.original_total_qty = 0.0
                        track_extremes(pos, px2, px2)
                        break

        if pos.outcome == "open":
            pos.exit_i = len(candles) - 1
        wallet += pos.gross_pnl - pos.fees - pos.slippage
        campaigns.append(pos)
        cursor = pos.exit_i

    return campaigns, wallet


def net(p: Campaign) -> float: return p.gross_pnl - p.fees - p.slippage


def summarize(campaigns, wallet_end, leverage):
    n = len(campaigns)
    closed = [p for p in campaigns if p.outcome != "open"]
    tp_full = [p for p in campaigns if p.outcome == "tp_full"]
    floors = [p for p in campaigns if p.outcome == "hard_floor"]
    opens = [p for p in campaigns if p.outcome == "open"]
    partial_then_floor = [p for p in floors if any(p.rung_done)]

    avg_tr = (sum(p.max_tranches_reached for p in campaigns) / n) if n else 0.0
    max_tr = max((p.max_tranches_reached for p in campaigns), default=0)

    imps = []
    for p in campaigns:
        if not p.tranches and not p.rung_done[0] is None: pass
        first_px = p.tranches[0].entry_px if p.tranches else 0.0
        # if position closed we lost the tranches list — use synthetic: track separately? we didn't
        # approximate: use avg from remaining if still open, else skip
        if p.total_qty() > 0 and first_px:
            avg = p.avg_entry()
            imp = (first_px - avg)/first_px*100 if p.direction=="long" else (avg-first_px)/first_px*100
            imps.append(imp)
    avg_imp = sum(imps)/len(imps) if imps else 0.0

    rung_fires = [sum(1 for p in campaigns if p.rung_done[k]) for k in range(3)]

    gross = sum(p.gross_pnl for p in campaigns)
    fees = sum(p.fees for p in campaigns)
    slip = sum(p.slippage for p in campaigns)
    net_total = sum(net(p) for p in campaigns)
    fills = sum(p.fills for p in campaigns)

    winners = [p for p in closed if net(p) > 0]
    losers = [p for p in closed if net(p) <= 0]
    win_rate = (len(winners)/len(closed)*100) if closed else 0.0
    avg_win = (sum(net(p) for p in winners)/len(winners)) if winners else 0.0
    avg_loss = (sum(net(p) for p in losers)/len(losers)) if losers else 0.0
    largest_loss = min((net(p) for p in losers), default=0.0)

    holds = [(p.exit_i - p.open_i) for p in closed]
    avg_hold = sum(holds)/len(holds) if holds else 0.0

    # equity curve drawdown
    equity = WALLET_START; peak = equity; min_eq = equity; max_dd = 0.0
    for p in campaigns:
        equity += net(p)
        peak = max(peak, equity)
        min_eq = min(min_eq, equity)
        max_dd = max(max_dd, peak - equity)

    peak_notional = max((p.peak_notional for p in campaigns), default=0.0)
    avg_peak_notional = sum(p.peak_notional for p in campaigns)/n if n else 0.0

    # Liquidation approximation: cross-margin liq when unrealized loss >= wallet_equity_available.
    # Report closest approach as pct of wallet.
    worst_upnl_pct = 0.0
    worst_upnl_abs = 0.0
    liq_count = 0
    for p in campaigns:
        pct = -p.worst_unrealized_pnl / WALLET_START * 100
        if pct > worst_upnl_pct:
            worst_upnl_pct = pct
            worst_upnl_abs = p.worst_unrealized_pnl
        if -p.worst_unrealized_pnl >= WALLET_START:
            liq_count += 1

    return {
        "n": n, "leverage": leverage,
        "tp_full": len(tp_full), "floors": len(floors), "opens": len(opens),
        "partial_then_floor": len(partial_then_floor),
        "avg_tr": avg_tr, "max_tr": max_tr, "avg_imp": avg_imp,
        "rung_fires": rung_fires,
        "gross": gross, "fees": fees, "slip": slip, "net": net_total, "fills": fills,
        "win_rate": win_rate, "avg_win": avg_win, "avg_loss": avg_loss,
        "largest_loss": largest_loss, "avg_hold": avg_hold,
        "max_dd": max_dd, "min_eq": min_eq, "wallet_end": wallet_end,
        "peak_notional": peak_notional, "avg_peak_notional": avg_peak_notional,
        "worst_upnl_pct": worst_upnl_pct, "worst_upnl_abs": worst_upnl_abs,
        "liq_count": liq_count,
    }


def report(sym, s):
    print(f"\n  === {sym} (leverage={s['leverage']}x) ===")
    L = s['leverage']
    mf = NOTIONAL_CONST/L
    tm = mf*WALLET_START
    tn = tm*L
    print(f"    sizing: mf={mf:.3f}  margin/tranche=${tm:.2f}  notional/tranche=${tn:.2f}  cap={MAX_TRANCHES} tranches")
    print(f"    positions opened            : {s['n']}")
    print(f"    tranches/campaign avg | max : {s['avg_tr']:.2f} | {s['max_tr']} (out of {MAX_TRANCHES})")
    print(f"    avg-entry improvement (open): {s['avg_imp']:+.4f}%")
    print(f"    closes tp_full / partial+floor / floor / open : "
          f"{s['tp_full']} / {s['partial_then_floor']} / {s['floors']-s['partial_then_floor']} / {s['opens']}")
    print(f"    TP rung fires (50%/30%/20%) : {s['rung_fires'][0]} / {s['rung_fires'][1]} / {s['rung_fires'][2]}")
    print(f"    HARD FLOOR ($500) hits      : {s['floors']}")
    print(f"    gross | fees | slip | NET $ : {s['gross']:+.2f} | {s['fees']:.2f} | {s['slip']:.2f} | {s['net']:+.2f}")
    print(f"    total fills                 : {s['fills']}")
    print(f"    win% | avg win | avg loss | largest loss : "
          f"{s['win_rate']:.1f}% | {s['avg_win']:+.2f} | {s['avg_loss']:+.2f} | {s['largest_loss']:+.2f}")
    print(f"    avg hold (candles / hours)  : {s['avg_hold']:.1f} / {s['avg_hold']*5/60:.2f}")
    print(f"    wallet end / MAX DD / MIN EQ: ${s['wallet_end']:.2f} / ${s['max_dd']:.2f} / ${s['min_eq']:.2f}")
    print(f"    peak notional (max|avg)     : ${s['peak_notional']:,.0f} | ${s['avg_peak_notional']:,.0f}")
    print(f"    WORST unreal loss           : ${s['worst_upnl_abs']:+.2f}  ({s['worst_upnl_pct']:.1f}% of wallet)")
    print(f"    LIQUIDATIONS (upnl>=wallet) : {s['liq_count']}  {'*** BLOWN ***' if s['liq_count'] else '(floor held)'}")


def main():
    # SOL max on ApeX is 50x, BTC/ETH 100x
    symbol_leverage = {"BTC-USDT": 100.0, "ETH-USDT": 100.0, "SOL-USDT": 50.0}
    hours = 168

    print("="*82)
    print(f"BACKTEST: 5-tranche DCA @ confirmed retest, +50% margin TP ladder (50/30/20),")
    print(f"          HARD FLOOR flatten when account equity <= ${HARD_FLOOR:.0f}")
    print(f"          wallet=${WALLET_START:.0f}, one campaign at a time")
    print(f"          fees=taker {TAKER_FEE_BPS}bps + slip {SLIPPAGE_BPS}bps every fill, funding NOT modeled")
    print(f"          TP ladder rungs: sell 50% at +50% margin ROI, 30% at +55%, 20% at +60% (documented)")
    print(f"          Leverage: BTC-USDT=100x, ETH-USDT=100x, SOL-USDT=50x (ApeX venue cap)")
    print("="*82)

    feed = md.ApexPublicFeed()
    for sym, L in symbol_leverage.items():
        try:
            print(f"\n[{sym}] fetching {hours}h of 5m candles @ {L:.0f}x ...")
            f = feed.fetch_range(sym, 5, hours=hours)
            longs = sig.evaluate(f.candles, "long", f.tick)["entries"]
            shorts = sig.evaluate(f.candles, "short", f.tick)["entries"]
            print(f"[{sym}] candles={len(f.candles)}  confirmed retests long={len(longs)} short={len(shorts)}")
            campaigns, wallet_end = simulate(f.candles, longs, shorts, L)
            s = summarize(campaigns, wallet_end, L)
            report(sym, s)
        except Exception as e:
            print(f"\n[{sym}] BLOCKED — real error:\n{type(e).__name__}: {e}")
            traceback.print_exc()
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
