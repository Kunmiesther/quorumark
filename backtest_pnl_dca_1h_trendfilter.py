"""W1 30d BTC backtest + 1H EMA trend filter — sweep periods 50 / 21 / 15.

Base = validated W1 (100x, 5-tranche DCA on confirmed 5m retest, TP ladder
50/30/20 @ +50/+55/+60% margin ROI, $500 hard equity floor, one-at-a-time).
The ONLY change vs the 30d baseline: a 1H EMA trend filter that vetoes
counter-trend 5m entries.

  1H close > 1H EMA(period)  -> uptrend   -> ONLY long entries allowed
  1H close < 1H EMA(period)  -> downtrend -> ONLY short entries allowed
  equal                       -> no side allowed (rare)

The 1H series is built by aggregating the same 5m candles (720h * 12 = 8640
five-minute candles -> 720 hourly candles). At each 5m candle, the "current
1H trend" is derived from the LAST FULLY-COMPLETED 1H bar (no lookahead).

Costs: taker 5bps + slip 2bps per fill. Funding NOT modeled.
Strategy files untouched. Data: ApeX public klines (real or honest blocked).
"""
from __future__ import annotations
import traceback
from dataclasses import dataclass, field
from typing import Optional

import accumulator_signal as sig
import market_data as md

WALLET_START   = 600.0
HARD_FLOOR     = 500.0
MAX_TRANCHES   = 5
FEE_RATE       = 5.0 / 10_000.0
SLIP_RATE      = 2.0 / 10_000.0
NOTIONAL_CONST = 10.0
LEVERAGE       = 100.0
TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

TP_LADDER = [(0.50, 0.50), (0.30, 0.55), (0.20, 0.60)]  # (frac_of_original, margin_roi)

# BASELINE (unfiltered 30d W1) — from prior dual-wallet run
BASELINE = {
    "n": 3, "tpf": 2, "fl": 1, "op": 0, "net": -112.69,
    "avg_win": 23.86, "largest_loss": -160.00, "floor_hits": 1,
}


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
    outcome: str = "open"

    def total_qty(self):
        return sum(t.qty for t in self.tranches)

    def avg_entry(self):
        q = self.total_qty()
        return sum(t.qty * t.entry_px for t in self.tranches) / q if q > 0 else 0.0


def unrealized(pos, price):
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


# ---------------------------------------------------------------------------
# 1H aggregation + EMA
# ---------------------------------------------------------------------------
def aggregate_5m_to_1h(candles):
    """Return list of (close_5m_index, hourly_close). One entry per completed 1H bar.

    A 1H bar completes on the 12th 5m candle of that hour (index % 12 == 11
    when the series starts on an hourly boundary; we defensively bucket by
    floor(ts / 3600000)).
    """
    buckets: dict[int, list[int]] = {}
    order: list[int] = []
    for i, c in enumerate(candles):
        h = int(float(c[TS]) // 3_600_000)
        if h not in buckets:
            buckets[h] = []
            order.append(h)
        buckets[h].append(i)
    out = []  # (last_5m_index_of_bar, close_price)
    for h in order:
        idxs = buckets[h]
        last_i = idxs[-1]
        close = float(candles[last_i][CLOSE])
        out.append((last_i, close, h))
    return out


def ema_trend_map(candles, period):
    """For every 5m index i, return trend in {"long","short","flat"} using the
    LAST COMPLETED 1H bar strictly before i (no lookahead)."""
    hourly = aggregate_5m_to_1h(candles)
    # Compute EMA over hourly closes, SMA-seeded.
    closes = [c for (_, c, _) in hourly]
    n = len(closes)
    ema: list[Optional[float]] = [None] * n
    if n >= period:
        seed = sum(closes[:period]) / period
        ema[period - 1] = seed
        k = 2.0 / (period + 1)
        prev = seed
        for i in range(period, n):
            prev = closes[i] * k + prev * (1 - k)
            ema[i] = prev
    # For each hourly bar, decide trend (only when EMA defined).
    hourly_trend: list[tuple[int, str]] = []  # (last_5m_index_of_bar, trend)
    for h_idx, ((last_i, close, _), e) in enumerate(zip(hourly, ema)):
        if e is None:
            hourly_trend.append((last_i, "flat"))
        elif close > e:
            hourly_trend.append((last_i, "long"))
        elif close < e:
            hourly_trend.append((last_i, "short"))
        else:
            hourly_trend.append((last_i, "flat"))
    # Propagate to a per-5m map using LAST COMPLETED bar (strictly before i).
    trend_at: list[str] = ["flat"] * len(candles)
    curr = "flat"
    hp = 0  # pointer into hourly_trend
    for i in range(len(candles)):
        # advance curr as hourly bars complete strictly before i
        while hp < len(hourly_trend) and hourly_trend[hp][0] < i:
            curr = hourly_trend[hp][1]
            hp += 1
        trend_at[i] = curr
    return trend_at


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------
def check_floor(state, j, hi, lo, cl):
    pos = state["open"]
    if pos is None: return False
    d = pos.direction
    adverse = lo if d == "long" else hi
    eq_adv = state["wallet"] + pos.gross_pnl - pos.fees - pos.slippage + unrealized(pos, adverse)
    if eq_adv <= HARD_FLOOR:
        base = state["wallet"] + pos.gross_pnl - pos.fees - pos.slippage
        q = pos.total_qty(); avg = pos.avg_entry()
        need = HARD_FLOOR - base
        if q > 0:
            trig = (avg + need/q) if d == "long" else (avg - need/q)
            trig = max(lo, min(hi, trig))
        else:
            trig = cl
        close_qty(pos, pos.total_qty(), trig)
        pos.exit_i = j
        pos.outcome = "hard_floor"
        state["wallet"] += pos.gross_pnl - pos.fees - pos.slippage
        state["campaigns"].append(pos)
        state["open"] = None
        if state["wallet"] <= HARD_FLOOR:
            state["halted"] = True
        return True
    return False


def try_tp(state, j, hi, lo):
    pos = state["open"]
    if pos is None: return False
    for k, (frac, roi) in enumerate(TP_LADDER):
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
                state["wallet"] += pos.gross_pnl - pos.fees - pos.slippage
                state["campaigns"].append(pos)
                state["open"] = None
                return True
    return False


def simulate(candles, entries_long, entries_short, trend_at, tranche_notional):
    evs = []
    for r in entries_long:  evs.append((r.retest_index, "long", float(candles[r.retest_index][CLOSE])))
    for r in entries_short: evs.append((r.retest_index, "short", float(candles[r.retest_index][CLOSE])))
    evs.sort(key=lambda x: x[0])
    ev_by_i: dict[int, list] = {}
    for i, d, px in evs:
        ev_by_i.setdefault(i, []).append((d, px))

    state = {"wallet": WALLET_START, "campaigns": [], "open": None, "halted": False}
    vetoed = 0
    considered = 0

    for j in range(len(candles)):
        c = candles[j]
        hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])

        if state["open"] is not None:
            track_extremes(state["open"], hi, lo)

        check_floor(state, j, hi, lo, cl)
        try_tp(state, j, hi, lo)

        # DCA add
        pos = state["open"]
        if pos is not None and len(pos.tranches) < MAX_TRANCHES and j in ev_by_i:
            for d2, px2 in ev_by_i[j]:
                if d2 != pos.direction: continue
                # (DCA adds are NOT filter-vetoed — spec is direction-locked to
                # the campaign already open, so trend has already been validated.)
                better = (px2 < pos.last_entry_px) if pos.direction == "long" else (px2 > pos.last_entry_px)
                if better:
                    open_tranche(pos, px2, tranche_notional)
                    pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
                    if not any(pos.rung_done):
                        pos.original_total_qty = 0.0
                    break

        # New campaign (filter applied here)
        if not state["halted"] and state["open"] is None and j in ev_by_i:
            for d, px in ev_by_i[j]:
                considered += 1
                trend = trend_at[j]
                if trend != d:
                    vetoed += 1
                    continue
                pos = Campaign(d, j, float(c[TS]))
                open_tranche(pos, px, tranche_notional)
                pos.max_tranches_reached = 1
                track_extremes(pos, px, px)
                state["open"] = pos
                break

    if state["open"] is not None:
        state["open"].exit_i = len(candles) - 1
        state["campaigns"].append(state["open"])
        state["open"] = None
    return state, considered, vetoed


def net(p): return p.gross_pnl - p.fees - p.slippage


def summarize(state):
    camps = state["campaigns"]
    n = len(camps)
    tpf = [p for p in camps if p.outcome == "tp_full"]
    fl  = [p for p in camps if p.outcome == "hard_floor"]
    op  = [p for p in camps if p.outcome == "open"]
    rung_fires = [sum(1 for p in camps if p.rung_done[k]) for k in range(3)]
    gross = sum(p.gross_pnl for p in camps)
    fees  = sum(p.fees for p in camps)
    slip  = sum(p.slippage for p in camps)
    netv  = sum(net(p) for p in camps)
    closed = [p for p in camps if p.outcome != "open"]
    winners = [p for p in closed if net(p) > 0]
    losers  = [p for p in closed if net(p) <= 0]
    win_rate = (len(winners)/len(closed)*100) if closed else 0.0
    avg_win  = (sum(net(p) for p in winners)/len(winners)) if winners else 0.0
    avg_loss = (sum(net(p) for p in losers)/len(losers)) if losers else 0.0
    largest_loss = min((net(p) for p in losers), default=0.0)
    holds = [(p.exit_i - p.open_i) for p in closed]
    avg_hold = sum(holds)/len(holds) if holds else 0.0
    avg_tr = (sum(p.max_tranches_reached for p in camps)/n) if n else 0.0
    max_tr = max((p.max_tranches_reached for p in camps), default=0)
    worst_upnl = min((p.worst_unrealized_pnl for p in camps), default=0.0)
    liq = sum(1 for p in camps if -p.worst_unrealized_pnl >= WALLET_START)
    return dict(n=n, tpf=len(tpf), fl=len(fl), op=len(op), rung_fires=rung_fires,
                gross=gross, fees=fees, slip=slip, net=netv,
                win_rate=win_rate, avg_win=avg_win, avg_loss=avg_loss,
                largest_loss=largest_loss, avg_hold=avg_hold,
                avg_tr=avg_tr, max_tr=max_tr,
                worst_upnl=worst_upnl, liq=liq,
                halted=state["halted"], wallet_end=state["wallet"])


def main():
    sym = "BTC-USDT"
    hours = 720
    print("="*90)
    print("W1 + 1H EMA trend filter sweep — 30d BTC-USDT, 5m entries")
    print("Filter: 1H close vs 1H EMA(period) using LAST COMPLETED 1H bar (no lookahead)")
    print(f"$600, 100x, 5-tranche DCA on confirmed 5m retest, TP 50/30/20 @ +50/+55/+60% margin ROI, $500 floor")
    print(f"Fees taker 5bps + slip 2bps per fill; funding NOT modeled")
    print("="*90)

    feed = md.ApexPublicFeed()
    try:
        print(f"\n[{sym}] fetching {hours}h of 5m candles ...")
        f = feed.fetch_range(sym, 5, hours=hours)
        longs = sig.evaluate(f.candles, "long", f.tick)["entries"]
        shorts = sig.evaluate(f.candles, "short", f.tick)["entries"]
        cl_l = [r for r in longs if r.state == "confirmed"]
        cl_s = [r for r in shorts if r.state == "confirmed"]
        print(f"[{sym}] candles={len(f.candles)}  confirmed retests long={len(cl_l)} short={len(cl_s)}")

        mf = NOTIONAL_CONST / LEVERAGE
        tm = mf * WALLET_START
        tn = tm * LEVERAGE
        print(f"sizing: mf={mf:.3f}  margin/tranche=${tm:.2f}  notional/tranche=${tn:.2f}  cap={MAX_TRANCHES}")

        results = {}
        for period in (50, 21, 15):
            trend_at = ema_trend_map(f.candles, period)
            # Count trend distribution for context
            up = sum(1 for t in trend_at if t == "long")
            dn = sum(1 for t in trend_at if t == "short")
            fl_ = len(trend_at) - up - dn
            state, considered, vetoed = simulate(f.candles, cl_l, cl_s, trend_at, tn)
            s = summarize(state)
            s["considered"] = considered
            s["vetoed"] = vetoed
            s["trend_dist"] = (up, dn, fl_)
            results[period] = s

        # Comparison table
        print("\n" + "="*90)
        print("COMPARISON — three 1H EMA periods vs unfiltered BASELINE (all $600, 30d BTC)")
        print("="*90)

        rows = [("EMA period",       "BASELINE", "50",  "21",  "15")]
        def fmt(v, sp="{:>10}"): return sp.format(v)
        def line(label, base, a, b, c, f2="{:>10.2f}", fi="{:>10d}"):
            def cell(v, is_int):
                if isinstance(v, str): return "{:>10}".format(v)
                return fi.format(v) if is_int else f2.format(v)
            is_int = isinstance(a, int)
            print(f"  {label:<38}{cell(base, is_int)}{cell(a, is_int)}{cell(b, is_int)}{cell(c, is_int)}")

        print(f"  {'':<38}{'BASELINE':>10}{'EMA50':>10}{'EMA21':>10}{'EMA15':>10}")
        line("entries considered (5m signals)", "-", results[50]["considered"], results[21]["considered"], results[15]["considered"])
        line("entries vetoed by 1H filter",     "0", results[50]["vetoed"],     results[21]["vetoed"],     results[15]["vetoed"])
        line("campaigns opened",                BASELINE["n"], results[50]["n"], results[21]["n"], results[15]["n"])
        line("avg tranches/campaign",           "-", results[50]["avg_tr"], results[21]["avg_tr"], results[15]["avg_tr"])
        line("max tranches",                    "-", results[50]["max_tr"], results[21]["max_tr"], results[15]["max_tr"])
        line("closes: tp_full",                 BASELINE["tpf"], results[50]["tpf"], results[21]["tpf"], results[15]["tpf"])
        line("closes: hard_floor",              BASELINE["fl"],  results[50]["fl"],  results[21]["fl"],  results[15]["fl"])
        line("closes: open at end",             BASELINE["op"],  results[50]["op"],  results[21]["op"],  results[15]["op"])
        line("TP1 fires (+50%)",                "-", results[50]["rung_fires"][0], results[21]["rung_fires"][0], results[15]["rung_fires"][0])
        line("TP2 fires (+55%)",                "-", results[50]["rung_fires"][1], results[21]["rung_fires"][1], results[15]["rung_fires"][1])
        line("TP3 fires (+60%)",                "-", results[50]["rung_fires"][2], results[21]["rung_fires"][2], results[15]["rung_fires"][2])
        line("gross PnL $",                     "-", results[50]["gross"], results[21]["gross"], results[15]["gross"])
        line("fees $",                          "-", results[50]["fees"],  results[21]["fees"],  results[15]["fees"])
        line("slippage $",                      "-", results[50]["slip"],  results[21]["slip"],  results[15]["slip"])
        line("NET PnL $",                       BASELINE["net"], results[50]["net"], results[21]["net"], results[15]["net"])
        line("win rate %",                      "-", results[50]["win_rate"], results[21]["win_rate"], results[15]["win_rate"])
        line("avg win $",                       BASELINE["avg_win"], results[50]["avg_win"], results[21]["avg_win"], results[15]["avg_win"])
        line("avg loss $",                      "-", results[50]["avg_loss"], results[21]["avg_loss"], results[15]["avg_loss"])
        line("largest loss $",                  BASELINE["largest_loss"], results[50]["largest_loss"], results[21]["largest_loss"], results[15]["largest_loss"])
        line("floor hits",                      BASELINE["floor_hits"], results[50]["fl"], results[21]["fl"], results[15]["fl"])
        line("liquidations",                    0, results[50]["liq"], results[21]["liq"], results[15]["liq"])
        line("worst unrealized $",              "-", results[50]["worst_upnl"], results[21]["worst_upnl"], results[15]["worst_upnl"])
        line("avg hold (candles)",              "-", results[50]["avg_hold"], results[21]["avg_hold"], results[15]["avg_hold"])
        line("wallet end $",                    "-", results[50]["wallet_end"], results[21]["wallet_end"], results[15]["wallet_end"])

        print()
        for p in (50, 21, 15):
            up, dn, flt = results[p]["trend_dist"]
            total = up + dn + flt
            print(f"  EMA{p} trend distribution over 5m candles: "
                  f"up={up} ({up/total*100:.1f}%)  down={dn} ({dn/total*100:.1f}%)  flat={flt} ({flt/total*100:.1f}%)")

        # Plain paragraph verdict
        print("\n" + "="*90)
        print("PLAIN ASSESSMENT")
        print("="*90)
        best_p = max(results, key=lambda k: results[k]["net"])
        best = results[best_p]
        any_profit = any(results[p]["net"] > 0 for p in results)
        print(f"* Any filter flip W1 to profit? {'YES' if any_profit else 'NO'}")
        print(f"* Best config: EMA{best_p} at NET ${best['net']:+.2f} vs baseline NET ${BASELINE['net']:+.2f} "
              f"(delta {best['net'] - BASELINE['net']:+.2f})")
        for p in (50, 21, 15):
            r = results[p]
            print(f"  - EMA{p}: campaigns={r['n']} vetoed={r['vetoed']} floor_hits={r['fl']} "
                  f"net=${r['net']:+.2f} largest_loss=${r['largest_loss']:+.2f}")
        # Did filter reduce floor-hits?
        min_fl = min(results[p]["fl"] for p in results)
        print(f"* Floor-hit reduction: baseline {BASELINE['floor_hits']} vs best-filter {min_fl}  "
              f"({'FILTER HELPED' if min_fl < BASELINE['floor_hits'] else 'NO REDUCTION'})")
        print(f"* Final verdict on best config (EMA{best_p}): "
              f"{'NET POSITIVE' if best['net'] > 0 else 'STILL LOSING'}")

    except Exception as e:
        print("\n!!! DATA FETCH / RUN FAILED — reporting honestly (no fabrication):")
        print(f"    {type(e).__name__}: {e}")
        traceback.print_exc()
        print("\nIf this is 'ApeX egress blocked' or similar network error, "
              "the backtest must be run on Railway or another environment with ApeX access.")


if __name__ == "__main__":
    main()
