"""CONCEPT EXPLORATION — Two-Wallet Dual-Account Backtest (Addendum A, UNRATIFIED).

30 days of 5m BTC-USDT. Two SEPARATE $600 accounts, each 100x, own margin pool,
own $500 hard equity floor. W1: 5-tranche DCA on any confirmed retest; TP ladder
50%/30%/20% at +50/+55/+60% margin ROI. W2: opens ONLY on confirmed signal
opposite to W1's current open direction (or any confirmed if W1 flat); single
+40% margin ROI full-close TP; 5-tranche DCA same sizing.

Costs: taker 5bps + slip 2bps per fill. Funding NOT modeled.
Strategy files untouched. Data: ApeX public klines (real, or honest blocked).
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
FEE_RATE         = 5.0 / 10_000.0
SLIP_RATE        = 2.0 / 10_000.0
NOTIONAL_CONST   = 10.0
LEVERAGE         = 100.0
TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

W1_TP_LADDER = [(0.50, 0.50), (0.30, 0.55), (0.20, 0.60)]  # (frac_of_original, margin_roi)
W2_TP_MARGIN_ROI = 0.40  # single full-close


@dataclass
class Tranche:
    qty: float
    entry_px: float


@dataclass
class Campaign:
    wallet: str
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
    outcome: str = "open"

    def total_qty(self) -> float:
        return sum(t.qty for t in self.tranches)

    def avg_entry(self) -> float:
        q = self.total_qty()
        return sum(t.qty * t.entry_px for t in self.tranches) / q if q > 0 else 0.0


def unrealized(pos: Campaign, price: float) -> float:
    q = pos.total_qty()
    if q <= 0: return 0.0
    avg = pos.avg_entry()
    return (price - avg) * q if pos.direction == "long" else (avg - price) * q


def tp_price(avg, direction, roi, lev):
    move = roi / lev
    return avg * (1 + move) if direction == "long" else avg * (1 - move)


def apply_fill(pos, qty, price):
    n = qty * price
    pos.fees += n * FEE_RATE
    pos.slippage += n * SLIP_RATE
    pos.fills += 1


def open_tranche(pos, price, tranche_notional):
    qty = tranche_notional / price
    apply_fill(pos, qty, price)
    pos.tranches.append(Tranche(qty, price))
    pos.last_entry_px = price


def close_qty(pos, qty, price):
    if qty <= 0 or pos.total_qty() <= 0: return
    qty = min(qty, pos.total_qty())
    avg = pos.avg_entry()
    if pos.direction == "long":
        pos.gross_pnl += (price - avg) * qty
    else:
        pos.gross_pnl += (avg - price) * qty
    apply_fill(pos, qty, price)
    rem = qty
    while rem > 1e-12 and pos.tranches:
        last = pos.tranches[-1]
        take = min(last.qty, rem)
        last.qty -= take
        rem -= take
        if last.qty <= 1e-12:
            pos.tranches.pop()


def track_extremes(pos, hi, lo):
    q = pos.total_qty()
    if q <= 0: return
    adverse = lo if pos.direction == "long" else hi
    upnl = unrealized(pos, adverse)
    if upnl < pos.worst_unrealized_pnl:
        pos.worst_unrealized_pnl = upnl
    for px in (hi, lo):
        n = q * px
        if n > pos.peak_notional:
            pos.peak_notional = n


@dataclass
class WalletState:
    name: str
    wallet: float = WALLET_START
    campaigns: list[Campaign] = field(default_factory=list)
    open_pos: Optional[Campaign] = None
    halted: bool = False
    concurrent_candles: int = 0


def check_floor_and_close(w: WalletState, j, c, hi, lo, cl) -> bool:
    """Return True if closed due to floor."""
    pos = w.open_pos
    if pos is None: return False
    direction = pos.direction
    adverse = lo if direction == "long" else hi
    eq_adverse = w.wallet + pos.gross_pnl - pos.fees - pos.slippage + unrealized(pos, adverse)
    if eq_adverse <= HARD_FLOOR:
        base = w.wallet + pos.gross_pnl - pos.fees - pos.slippage
        q = pos.total_qty(); avg = pos.avg_entry()
        need = HARD_FLOOR - base
        if q > 0:
            trig = (avg + need/q) if direction == "long" else (avg - need/q)
            trig = max(lo, min(hi, trig))
        else:
            trig = cl
        close_qty(pos, pos.total_qty(), trig)
        pos.exit_i = j
        pos.outcome = "hard_floor"
        w.wallet += pos.gross_pnl - pos.fees - pos.slippage
        w.campaigns.append(pos)
        w.open_pos = None
        if w.wallet <= HARD_FLOOR:
            w.halted = True
        return True
    return False


def try_tp_w1(w: WalletState, j, c, hi, lo) -> bool:
    pos = w.open_pos
    if pos is None: return False
    for k, (frac, roi) in enumerate(W1_TP_LADDER):
        if pos.rung_done[k] or pos.total_qty() <= 0: continue
        avg = pos.avg_entry()
        tgt = tp_price(avg, pos.direction, roi, LEVERAGE)
        hit = (hi >= tgt) if pos.direction == "long" else (lo <= tgt)
        if hit:
            if pos.original_total_qty == 0:
                pos.original_total_qty = pos.total_qty()
            sell = pos.original_total_qty * frac
            close_qty(pos, sell, tgt)
            pos.rung_done[k] = True
            if all(pos.rung_done) or pos.total_qty() <= 1e-9:
                pos.exit_i = j
                pos.outcome = "tp_full"
                w.wallet += pos.gross_pnl - pos.fees - pos.slippage
                w.campaigns.append(pos)
                w.open_pos = None
                return True
    return False


def try_tp_w2(w: WalletState, j, c, hi, lo) -> bool:
    pos = w.open_pos
    if pos is None: return False
    avg = pos.avg_entry()
    tgt = tp_price(avg, pos.direction, W2_TP_MARGIN_ROI, LEVERAGE)
    hit = (hi >= tgt) if pos.direction == "long" else (lo <= tgt)
    if hit:
        close_qty(pos, pos.total_qty(), tgt)
        pos.exit_i = j
        pos.outcome = "tp_full"
        w.wallet += pos.gross_pnl - pos.fees - pos.slippage
        w.campaigns.append(pos)
        w.open_pos = None
        return True
    return False


def try_dca(w: WalletState, j, ev_by_i, tranche_notional):
    pos = w.open_pos
    if pos is None or len(pos.tranches) >= MAX_TRANCHES: return
    if j not in ev_by_i: return
    for d2, px2 in ev_by_i[j]:
        if d2 != pos.direction: continue
        better = (px2 < pos.last_entry_px) if pos.direction == "long" else (px2 > pos.last_entry_px)
        if better:
            open_tranche(pos, px2, tranche_notional)
            pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
            if not any(pos.rung_done):
                pos.original_total_qty = 0.0
            return


def simulate_dual(candles, entries_long, entries_short):
    margin_fraction = NOTIONAL_CONST / LEVERAGE
    tranche_margin = margin_fraction * WALLET_START
    tranche_notional = tranche_margin * LEVERAGE

    evs = []
    for r in entries_long:  evs.append((r.retest_index, "long", float(candles[r.retest_index][CLOSE])))
    for r in entries_short: evs.append((r.retest_index, "short", float(candles[r.retest_index][CLOSE])))
    evs.sort(key=lambda x: x[0])
    ev_by_i: dict[int, list] = {}
    for i, d, px in evs:
        ev_by_i.setdefault(i, []).append((d, px))

    w1 = WalletState("W1")
    w2 = WalletState("W2")

    # W1-alone shadow for drawdown comparison
    w1_alone_equity_curve: list[float] = []
    combined_equity_curve: list[float] = []

    for j in range(len(candles)):
        c = candles[j]
        hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])

        # 1. track extremes on both open
        for w in (w1, w2):
            if w.open_pos is not None:
                track_extremes(w.open_pos, hi, lo)

        # 2. floor checks
        check_floor_and_close(w1, j, c, hi, lo, cl)
        check_floor_and_close(w2, j, c, hi, lo, cl)

        # 3. TP checks
        try_tp_w1(w1, j, c, hi, lo)
        try_tp_w2(w2, j, c, hi, lo)

        # 4. DCA adds
        try_dca(w1, j, ev_by_i, tranche_notional)
        try_dca(w2, j, ev_by_i, tranche_notional)

        # 5. New campaign starts on events at this candle
        if j in ev_by_i:
            for d, px in ev_by_i[j]:
                # W1: opens on any confirmed if flat and not halted
                if not w1.halted and w1.open_pos is None:
                    pos = Campaign("W1", d, j, float(c[TS]))
                    open_tranche(pos, px, tranche_notional)
                    pos.max_tranches_reached = 1
                    track_extremes(pos, px, px)
                    w1.open_pos = pos
                # W2: opens on confirmed opposite to W1's current direction (or any if W1 flat)
                if not w2.halted and w2.open_pos is None:
                    if w1.open_pos is None or d != w1.open_pos.direction:
                        pos2 = Campaign("W2", d, j, float(c[TS]))
                        open_tranche(pos2, px, tranche_notional)
                        pos2.max_tranches_reached = 1
                        track_extremes(pos2, px, px)
                        w2.open_pos = pos2

        # 6. concurrent counter
        if w1.open_pos is not None and w2.open_pos is not None:
            w1.concurrent_candles += 1

        # 7. equity curves (mark-to-close)
        def eq(w: WalletState):
            base = w.wallet
            if w.open_pos is not None:
                base += w.open_pos.gross_pnl - w.open_pos.fees - w.open_pos.slippage + unrealized(w.open_pos, cl)
            return base
        w1_alone_equity_curve.append(eq(w1))
        combined_equity_curve.append(eq(w1) + eq(w2))

    # finalize opens
    for w in (w1, w2):
        if w.open_pos is not None:
            w.open_pos.exit_i = len(candles) - 1
            w.campaigns.append(w.open_pos)
            w.open_pos = None

    return w1, w2, w1_alone_equity_curve, combined_equity_curve, tranche_margin, tranche_notional


def net(p): return p.gross_pnl - p.fees - p.slippage


def summarize_wallet(w: WalletState):
    n = len(w.campaigns)
    tpf = [p for p in w.campaigns if p.outcome == "tp_full"]
    fl = [p for p in w.campaigns if p.outcome == "hard_floor"]
    op = [p for p in w.campaigns if p.outcome == "open"]
    rung_fires = [sum(1 for p in w.campaigns if p.rung_done[k]) for k in range(3)]
    gross = sum(p.gross_pnl for p in w.campaigns)
    fees = sum(p.fees for p in w.campaigns)
    slip = sum(p.slippage for p in w.campaigns)
    netv = sum(net(p) for p in w.campaigns)
    fills = sum(p.fills for p in w.campaigns)
    closed = [p for p in w.campaigns if p.outcome != "open"]
    winners = [p for p in closed if net(p) > 0]
    losers = [p for p in closed if net(p) <= 0]
    win_rate = (len(winners)/len(closed)*100) if closed else 0.0
    avg_win = (sum(net(p) for p in winners)/len(winners)) if winners else 0.0
    avg_loss = (sum(net(p) for p in losers)/len(losers)) if losers else 0.0
    largest_loss = min((net(p) for p in losers), default=0.0)
    holds = [(p.exit_i - p.open_i) for p in closed]
    avg_hold = sum(holds)/len(holds) if holds else 0.0
    avg_tr = (sum(p.max_tranches_reached for p in w.campaigns)/n) if n else 0.0
    max_tr = max((p.max_tranches_reached for p in w.campaigns), default=0)
    peak_notional = max((p.peak_notional for p in w.campaigns), default=0.0)
    worst_upnl = min((p.worst_unrealized_pnl for p in w.campaigns), default=0.0)
    worst_upnl_pct = -worst_upnl / WALLET_START * 100
    liq = sum(1 for p in w.campaigns if -p.worst_unrealized_pnl >= WALLET_START)
    return dict(n=n, tpf=len(tpf), fl=len(fl), op=len(op), rung_fires=rung_fires,
                gross=gross, fees=fees, slip=slip, net=netv, fills=fills,
                win_rate=win_rate, avg_win=avg_win, avg_loss=avg_loss,
                largest_loss=largest_loss, avg_hold=avg_hold,
                avg_tr=avg_tr, max_tr=max_tr, peak_notional=peak_notional,
                worst_upnl=worst_upnl, worst_upnl_pct=worst_upnl_pct, liq=liq,
                halted=w.halted, wallet_end=w.wallet)


def dd(curve, start=WALLET_START):
    peak = start; mx = 0.0; mn = start
    for e in curve:
        peak = max(peak, e)
        mn = min(mn, e)
        mx = max(mx, peak - e)
    return mx, mn


def report_wallet(name, s, tp_desc):
    print(f"\n  === {name} ({tp_desc}) ===")
    print(f"    campaigns opened            : {s['n']}")
    print(f"    tranches/campaign avg | max : {s['avg_tr']:.2f} | {s['max_tr']} (cap {MAX_TRANCHES})")
    print(f"    closes tp_full / floor / open: {s['tpf']} / {s['fl']} / {s['op']}")
    print(f"    TP rung fires               : {s['rung_fires']}")
    print(f"    floor halted?               : {s['halted']}  wallet end ${s['wallet_end']:.2f}")
    print(f"    gross | fees | slip | NET $ : {s['gross']:+.2f} | {s['fees']:.2f} | {s['slip']:.2f} | {s['net']:+.2f}")
    print(f"    total fills                 : {s['fills']}")
    print(f"    win% | avg win | avg loss | largest loss: "
          f"{s['win_rate']:.1f}% | {s['avg_win']:+.2f} | {s['avg_loss']:+.2f} | {s['largest_loss']:+.2f}")
    print(f"    avg hold (candles / hours)  : {s['avg_hold']:.1f} / {s['avg_hold']*5/60:.2f}")
    print(f"    peak notional exposure      : ${s['peak_notional']:,.0f}")
    print(f"    worst unrealized loss       : ${s['worst_upnl']:+.2f}  ({s['worst_upnl_pct']:.1f}% of wallet)")
    print(f"    liquidations (upnl>=wallet) : {s['liq']}  {'*** BLOWN ***' if s['liq'] else '(floor held)'}")


def main():
    sym = "BTC-USDT"
    hours = 720  # 30 days
    print("="*82)
    print("CONCEPT EXPLORATION — Two-Wallet Dual Account (UNRATIFIED, Addendum A)")
    print(f"BTC-USDT, 30 days (720h) of 5m candles, ApeX public klines")
    print(f"W1 $600 100x, 5-tranche DCA on confirmed retest, TP ladder 50/30/20 @ +50/+55/+60% margin ROI, $500 floor")
    print(f"W2 $600 100x, 5-tranche DCA on CONFIRMED-OPPOSITE retest, single +40% margin ROI full close, $500 floor")
    print(f"Fees: taker 5bps + slip 2bps per fill; funding NOT modeled")
    print("="*82)

    feed = md.ApexPublicFeed()
    try:
        print(f"\n[{sym}] fetching {hours}h of 5m candles ...")
        f = feed.fetch_range(sym, 5, hours=hours)
        longs = sig.evaluate(f.candles, "long", f.tick)["entries"]
        shorts = sig.evaluate(f.candles, "short", f.tick)["entries"]
        confirmed_l = [r for r in longs if r.state == "confirmed"]
        confirmed_s = [r for r in shorts if r.state == "confirmed"]
        print(f"[{sym}] candles={len(f.candles)}  confirmed retests long={len(confirmed_l)} short={len(confirmed_s)}")

        w1, w2, w1_curve, comb_curve, tm, tn = simulate_dual(f.candles, confirmed_l, confirmed_s)

        print(f"\n  sizing: mf={NOTIONAL_CONST/LEVERAGE:.3f}  margin/tranche=${tm:.2f}  notional/tranche=${tn:.2f}  cap={MAX_TRANCHES}")

        s1 = summarize_wallet(w1)
        s2 = summarize_wallet(w2)
        report_wallet("WALLET 1", s1, "TP ladder 50/30/20")
        report_wallet("WALLET 2", s2, "single TP +40% margin ROI")

        # combined stats
        combined_net = s1['net'] + s2['net']
        combined_end = w1.wallet + w2.wallet
        w1_dd, w1_min = dd(w1_curve)
        comb_dd, comb_min = dd(comb_curve, start=2*WALLET_START)

        print(f"\n  === COMBINED (both wallets on $1,200) ===")
        print(f"    combined NET PnL            : ${combined_net:+.2f}  ({combined_net/1200*100:+.2f}% on $1,200)")
        print(f"    wallet end (W1 + W2)        : ${combined_end:.2f}")
        print(f"    concurrent-open candles     : {w1.concurrent_candles} of {len(f.candles)} "
              f"({w1.concurrent_candles/len(f.candles)*100:.1f}% of time)")
        print(f"    W1-ALONE max DD | min equity: ${w1_dd:.2f} | ${w1_min:.2f}")
        print(f"    COMBINED max DD | min equity: ${comb_dd:.2f} | ${comb_min:.2f}")
        print(f"    combined DD vs W1-alone DD  : {comb_dd:.2f} vs {w1_dd:.2f}  "
              f"(hedge effect: {'REDUCED' if comb_dd < w1_dd else 'INCREASED OR EQUAL'})")
        print(f"    liquidations (either wallet): {s1['liq'] + s2['liq']}")

        # W2 deployment analysis
        print(f"\n  W2 deployment: {s2['n']} campaigns over 30 days "
              f"({s2['n']/30:.2f}/day) — {'RARE' if s2['n'] < 10 else 'REGULAR'}")

        print("\n" + "="*82)
        print("PLAIN ASSESSMENT")
        print("="*82)
        w1_profitable = "YES" if s1['net'] > 0 else "NO"
        combo_profitable = "YES" if combined_net > 0 else "NO"
        print(f"* W1 alone over 30d: {w1_profitable} (net ${s1['net']:+.2f} on $600)")
        print(f"* Two-wallet combo over 30d: {combo_profitable} (net ${combined_net:+.2f} on $1,200)")
        print(f"* W2 fired {s2['n']} campaigns; concurrent hedge periods = {w1.concurrent_candles} candles "
              f"({w1.concurrent_candles*5/60:.1f}h of 720h)")
        if comb_dd < w1_dd:
            print(f"* Combined DD (${comb_dd:.2f}) < W1-alone DD (${w1_dd:.2f}) — the independent opposite wallet DID reduce portfolio drawdown.")
        else:
            print(f"* Combined DD (${comb_dd:.2f}) >= W1-alone DD (${w1_dd:.2f}) — the second wallet did NOT reduce risk; it added independent losses.")
        if s1['liq'] + s2['liq'] == 0:
            print(f"* Zero liquidations — the $500 hard floor held on both wallets across 30 days.")
        else:
            print(f"* !!! {s1['liq']+s2['liq']} LIQUIDATION(S) — floor did NOT gate before wipeout.")
        print(f"* Reminder: this is CONCEPT EXPLORATION of the unratified Addendum A dual-wallet model — NOT a ratified strategy.")

    except Exception as e:
        print(f"\n[{sym}] BLOCKED — real error:\n{type(e).__name__}: {e}")
        traceback.print_exc()
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
