"""10-day 3-variant sweep-DCA harness — HARNESS ONLY.

Reuses the shipped detect_sweep + htf_bos code. No production files or
flags are touched. Runs three DCA geometries on the SAME signals/window
so differences are pure ladder geometry:

  A) SHIPPED SPEC : zone = 1.0 x ATR, 8 rungs
  B) OWNER VARIANT: zone = 0.6% of price, 6 rungs
  C) 4-RUNG CHECK : zone = 1.0 x ATR, 4 rungs

Common: $1000, 2% risk, 20x cap, taker fee 4bps, TP tiers 50/30/20 @
1.75/2.0/2.5R, hard stop = beyond deepest rung + 0.25 x ATR, 48-bar
1h timeout, 4h HTF alignment (aggregate_4h + detect_htf_bos).
"""
from __future__ import annotations

import json, math, os, sys, time, urllib.request
from dataclasses import dataclass
from typing import List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sweep_signal import (
    atr_series, detect_sweep,
    SWEEP_ATR_PERIOD, TS, OPEN, HIGH, LOW, CLOSE,
)
from htf_bos import aggregate_1h, aggregate_4h, detect_htf_bos

MIN5_MS = 5 * 60 * 1000
DAY_MS = 86_400_000
BARS_PER_DAY = DAY_MS // MIN5_MS
HORIZON_DAYS = 10
SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "DOGE-USDT", "XRP-USDT"]
STARTING_EQUITY = 1000.0
RISK_PER_TRADE = 0.02
LEVERAGE_CAP = 20
FEE = 0.0004
MAX_HOLD_BARS_1H = 48
DCA_STOP_ATR_BUFFER = 0.25
TP_TIERS = [(0.50, 1.75), (0.30, 2.0), (0.20, 2.5)]

# variant: (label, zone_mode, zone_param, rungs)
# zone_mode: "atr" => zone = param * atr,  "pct" => zone = param * price
VARIANTS = [
    ("C_atr10_4r",   "atr", 1.0,   4),
    ("D_pct05_4r",   "pct", 0.005, 4),
]


def _fetch_bybit(symbol: str, bars: int) -> Optional[List[list]]:
    sym = symbol.replace("-", "")
    try:
        all_rows: List[list] = []
        end = int(time.time() * 1000)
        needed = bars
        while needed > 0:
            batch = min(needed, 1000)
            url = (f"https://api.bybit.com/v5/market/kline?"
                   f"category=linear&symbol={sym}&interval=5&limit={batch}&end={end}")
            data = json.loads(urllib.request.urlopen(url, timeout=10).read())
            lst = data.get("result", {}).get("list", []) or []
            if not lst: break
            for r in lst:
                all_rows.append([int(r[0]), float(r[1]), float(r[2]),
                                 float(r[3]), float(r[4]), float(r[5])])
            end = int(lst[-1][0]) - 1
            needed -= len(lst)
            time.sleep(0.1)
        if len(all_rows) >= 500:
            dedup = {r[0]: r for r in all_rows}
            return [dedup[k] for k in sorted(dedup.keys())]
    except Exception as e:
        print(f"  fetch fail {symbol}: {e}", file=sys.stderr)
    return None


@dataclass
class Trade:
    symbol: str
    direction: str
    variant: str
    entry_ts: int
    exit_ts: int
    avg_entry: float
    hard_stop: float
    exit_reason: str
    pnl_usd: float
    rungs_filled: int = 0
    total_rungs: int = 0
    tiers_hit: Tuple[bool, bool, bool] = (False, False, False)


def _simulate(symbol: str, candles_5m: List[list],
              zone_mode: str, zone_param: float, rungs: int,
              variant_label: str) -> List[Trade]:
    trades: List[Trade] = []
    if len(candles_5m) < 300: return trades

    candles_1h = aggregate_1h(candles_5m)
    n1h = len(candles_1h)
    if n1h < 60: return trades
    atr = atr_series(candles_1h, SWEEP_ATR_PERIOD)

    _htf_cache: dict = {}
    def _htf_state_at(bar_close_ts: int) -> str:
        if bar_close_ts in _htf_cache: return _htf_cache[bar_close_ts]
        sub = [c for c in candles_5m if c[TS] <= bar_close_ts]
        htf_4h = aggregate_4h(sub)
        st = "none" if len(htf_4h) < 20 else detect_htf_bos(htf_4h, tick=0.0).state
        _htf_cache[bar_close_ts] = st
        return st

    equity = STARTING_EQUITY
    open_pos: Optional[dict] = None
    HOUR_MS = 60 * 60 * 1000

    for i in range(60, n1h):
        bar = candles_1h[i]
        hi, lo, close_px = bar[HIGH], bar[LOW], bar[CLOSE]

        if open_pos is not None:
            d = open_pos["direction"]
            still = []
            for rung_px, rung_qty in open_pos["pending"]:
                hit = (d == "long" and lo <= rung_px) or (d == "short" and hi >= rung_px)
                if hit:
                    open_pos["filled_qty"] += rung_qty
                    open_pos["filled_notional"] += rung_qty * rung_px
                    open_pos["rungs_filled"] += 1
                else:
                    still.append((rung_px, rung_qty))
            open_pos["pending"] = still
            if open_pos["filled_qty"] > 0:
                open_pos["avg_entry"] = open_pos["filled_notional"] / open_pos["filled_qty"]

            avg = open_pos["avg_entry"]
            stop = open_pos["hard_stop"]
            R = abs(avg - stop)
            for tier_i, (frac, rr) in enumerate(TP_TIERS):
                if open_pos["tiers_hit"][tier_i]: continue
                tp_px = avg + rr * R if d == "long" else avg - rr * R
                hit_tp = (d == "long" and hi >= tp_px) or (d == "short" and lo <= tp_px)
                if hit_tp and open_pos["filled_qty"] > 0:
                    reduce_qty = open_pos["filled_qty"] * frac
                    gross = (tp_px - avg) * reduce_qty if d == "long" else (avg - tp_px) * reduce_qty
                    fees = (avg + tp_px) * reduce_qty * FEE
                    open_pos["realized"] += gross - fees
                    open_pos["closed_qty"] += reduce_qty
                    open_pos["tiers_hit"][tier_i] = True

            hit_stop = ((d == "long" and lo <= stop) or (d == "short" and hi >= stop))
            timed_out = (i - open_pos["entry_i"]) >= MAX_HOLD_BARS_1H
            all_tiers_done = all(open_pos["tiers_hit"])
            if hit_stop or timed_out or all_tiers_done:
                remaining = open_pos["filled_qty"] - open_pos["closed_qty"]
                exit_px = stop if hit_stop else close_px
                reason = "sweep_stop" if hit_stop else ("all_tp" if all_tiers_done else "timeout")
                if remaining > 1e-12:
                    gross = (exit_px - avg) * remaining if d == "long" else (avg - exit_px) * remaining
                    fees = (avg + exit_px) * remaining * FEE
                    open_pos["realized"] += gross - fees
                equity += open_pos["realized"]
                trades.append(Trade(
                    symbol, d, variant_label,
                    open_pos["entry_ts"], bar[TS], avg, stop, reason,
                    open_pos["realized"], open_pos["rungs_filled"],
                    open_pos["total_rungs"],
                    tuple(open_pos["tiers_hit"]),
                ))
                open_pos = None
            else:
                continue

        window = candles_1h[: i + 1]
        atr_win = atr[: i + 1]
        htf_state = _htf_state_at(int(bar[TS]) + HOUR_MS - 1)
        r = detect_sweep(window, atr_win, htf_bos_state=htf_state, tick=0.0)
        if r is None: continue
        if r.direction == "long" and htf_state != "bullish_bos": continue
        if r.direction == "short" and htf_state != "bearish_bos": continue
        atr_now = atr_win[-1] or 0
        if atr_now <= 0: continue

        level = r.swept_level
        if zone_mode == "atr":
            zone = zone_param * atr_now
        else:
            zone = zone_param * level
        if zone <= 0: continue

        rung_prices: List[float] = []
        for k in range(rungs):
            frac = k / (rungs - 1) if rungs > 1 else 0.0
            px = level - frac * zone if r.direction == "long" else level + frac * zone
            rung_prices.append(px)
        deepest = rung_prices[-1]
        hard_stop = (deepest - DCA_STOP_ATR_BUFFER * atr_now
                     if r.direction == "long"
                     else deepest + DCA_STOP_ATR_BUFFER * atr_now)
        avg_if_full = sum(rung_prices) / rungs
        risk_dist = abs(avg_if_full - hard_stop)
        if risk_dist <= 0: continue
        total_qty = (equity * RISK_PER_TRADE) / risk_dist
        max_qty = (equity * LEVERAGE_CAP) / avg_if_full
        total_qty = min(total_qty, max_qty)
        if total_qty <= 0: continue
        qty_per_rung = total_qty / rungs

        filled_qty = 0.0; filled_notional = 0.0; rungs_filled = 0
        pending: List[Tuple[float, float]] = []
        for px in rung_prices:
            hit = (r.direction == "long" and lo <= px) or (r.direction == "short" and hi >= px)
            if hit:
                filled_qty += qty_per_rung
                filled_notional += qty_per_rung * px
                rungs_filled += 1
            else:
                pending.append((px, qty_per_rung))
        if filled_qty <= 0: continue
        avg_entry = filled_notional / filled_qty
        open_pos = {
            "direction": r.direction, "avg_entry": avg_entry,
            "hard_stop": hard_stop, "filled_qty": filled_qty,
            "filled_notional": filled_notional, "closed_qty": 0.0,
            "realized": -filled_notional * FEE,
            "entry_i": i, "entry_ts": bar[TS], "rungs_filled": rungs_filled,
            "total_rungs": rungs,
            "tiers_hit": [False, False, False], "pending": pending,
        }

    return trades


def _metrics(trades: List[Trade]) -> dict:
    if not trades:
        return {"trades": 0, "win_pct": 0, "avg_win": 0, "avg_loss": 0,
                "profit_factor": 0, "total_return": 0, "max_dd": 0}
    wins = [t.pnl_usd for t in trades if t.pnl_usd > 0]
    losses = [t.pnl_usd for t in trades if t.pnl_usd <= 0]
    total = sum(t.pnl_usd for t in trades)
    gw = sum(wins); gl = -sum(losses)
    pf = (gw / gl) if gl > 0 else (math.inf if gw > 0 else 0)
    eq = STARTING_EQUITY; peak = eq; dd = 0
    for t in trades:
        eq += t.pnl_usd; peak = max(peak, eq); dd = min(dd, eq - peak)
    return {"trades": len(trades),
            "win_pct": 100.0 * len(wins) / len(trades),
            "avg_win": (sum(wins)/len(wins)) if wins else 0,
            "avg_loss": (sum(losses)/len(losses)) if losses else 0,
            "profit_factor": pf, "total_return": total, "max_dd": dd}


def main():
    bars = HORIZON_DAYS * BARS_PER_DAY
    all_5m = {}
    src_by_sym = {}
    for sym in SYMBOLS:
        c = _fetch_bybit(sym, bars)
        src_by_sym[sym] = "bybit_proxy" if c else "unavailable"
        all_5m[sym] = c or []

    per_variant: dict = {}
    for label, zmode, zparam, rungs in VARIANTS:
        tr: List[Trade] = []
        for sym in SYMBOLS:
            if not all_5m[sym]: continue
            tr.extend(_simulate(sym, all_5m[sym], zmode, zparam, rungs, label))
        per_variant[label] = tr

    print(f"\nsymbols     : {SYMBOLS}")
    print(f"data source : {src_by_sym}")
    print(f"horizon     : {HORIZON_DAYS}d   equity: ${STARTING_EQUITY}   "
          f"lev cap: {LEVERAGE_CAP}x   risk/trade: {RISK_PER_TRADE*100:.1f}%")
    print(f"4h HTF alignment ACTIVE.  TP tiers 50/30/20 @ 1.75/2.0/2.5R.  "
          f"HS = deepest rung ± 0.25xATR.  timeout {MAX_HOLD_BARS_1H} 1h bars.")
    print(f"variants    : C=1.0xATR/4r  D=0.5%/4r")

    print("\n=== HEAD-TO-HEAD (overall) ===")
    hdr = (f"{'variant':<20} {'#':>4}  {'win%':>6}  {'avgW':>8}  "
           f"{'avgL':>8}  {'PF':>6}  {'maxDD':>9}  {'totRet':>10}")
    print(hdr); print("-" * len(hdr))
    for label, _, _, _ in VARIANTS:
        m = _metrics(per_variant[label])
        print(f"{label:<20} {m['trades']:>4}  {m['win_pct']:>5.1f}%  "
              f"{m['avg_win']:>+8.2f}  {m['avg_loss']:>+8.2f}  "
              f"{m['profit_factor']:>6.2f}  {m['max_dd']:>+9.2f}  "
              f"{m['total_return']:>+10.2f}")

    for label, _, _, rungs in VARIANTS:
        tr = per_variant[label]
        print(f"\n=== {label} — ladder / tier stats ===")
        n = len(tr)
        if n == 0:
            print("  no trades"); continue
        avg_rungs = sum(t.rungs_filled for t in tr) / n
        all_full = sum(1 for t in tr if t.rungs_filled >= rungs)
        stopped_full = sum(1 for t in tr
                           if t.rungs_filled >= rungs and t.exit_reason == "sweep_stop")
        t1 = sum(1 for t in tr if t.tiers_hit[0])
        t2 = sum(1 for t in tr if t.tiers_hit[1])
        t3 = sum(1 for t in tr if t.tiers_hit[2])
        print(f"  avg rungs filled / trade         : {avg_rungs:.2f} / {rungs}")
        print(f"  % trades all rungs filled        : {100.0*all_full/n:.1f}% ({all_full}/{n})")
        print(f"  % stopped at full ladder (worst) : {100.0*stopped_full/n:.1f}% ({stopped_full}/{n})")
        print(f"  tier hits: TP1 {100.0*t1/n:>5.1f}%  TP2 {100.0*t2/n:>5.1f}%  TP3 {100.0*t3/n:>5.1f}%")
        rmix = {"sweep_stop": 0, "all_tp": 0, "timeout": 0}
        for t in tr: rmix[t.exit_reason] = rmix.get(t.exit_reason, 0) + 1
        print(f"  exits: sweep_stop {rmix['sweep_stop']}  all_tp {rmix['all_tp']}  timeout {rmix['timeout']}")


if __name__ == "__main__":
    main()
