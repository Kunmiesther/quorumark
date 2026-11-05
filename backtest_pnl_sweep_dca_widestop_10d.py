"""10-day wide-stop cross-margin harness — HARNESS ONLY.

Same signals, 4-rung 1.0xATR ladder. Varies ONLY the hard-stop buffer
past the deepest rung and (for E2/F2) the sizing rule.

C  : buffer 0.25 x ATR, risk 2%      (current leader baseline)
E  : buffer 1.00 x ATR, risk 2%      (wider stop, smaller qty)
F  : buffer 2.00 x ATR, risk 2%      (very wide, even smaller qty)
E2 : buffer 1.00 x ATR, same qty as C  (higher real risk)
F2 : buffer 2.00 x ATR, same qty as C  (higher real risk)

Also reports: how many of C's sweep_stop trades RECOVERED to profit
under E/F/E2/F2 (matched by symbol+entry_ts), and the portfolio-level
worst simultaneous open drawdown (sum of concurrent open-position
unrealized $ across all 5 symbols).

No production files touched.
"""
from __future__ import annotations

import json, math, os, sys, time, urllib.request
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

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
TP_TIERS = [(0.50, 1.75), (0.30, 2.0), (0.20, 2.5)]
ZONE_ATR_MULT = 1.0
RUNGS = 4
HOUR_MS = 60 * 60 * 1000

# variant: (label, buffer_atr, qty_mode)  qty_mode ∈ {"risk", "match_c"}
VARIANTS = [
    ("C_buf0.25_risk2%", 0.25, "risk"),
    ("E_buf1.00_risk2%", 1.00, "risk"),
    ("F_buf2.00_risk2%", 2.00, "risk"),
    ("E2_buf1.00_qtyC",  1.00, "match_c"),
    ("F2_buf2.00_qtyC",  2.00, "match_c"),
]


def _fetch_bybit(symbol: str, bars: int) -> Optional[List[list]]:
    sym = symbol.replace("-", "")
    try:
        rows: List[list] = []
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
                rows.append([int(r[0]), float(r[1]), float(r[2]),
                             float(r[3]), float(r[4]), float(r[5])])
            end = int(lst[-1][0]) - 1
            needed -= len(lst)
            time.sleep(0.1)
        if len(rows) >= 500:
            d = {r[0]: r for r in rows}
            return [d[k] for k in sorted(d.keys())]
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
    tiers_hit: Tuple[bool, bool, bool] = (False, False, False)
    min_unrealized: float = 0.0  # deepest DD $ during hold
    # per-bar open unrealized samples (ts -> unrealized$) for portfolio agg
    bar_pnl: Dict[int, float] = field(default_factory=dict)


def _simulate(symbol: str, candles_5m: List[list],
              buffer_atr: float, qty_mode: str,
              variant_label: str,
              c_qty_by_ts: Optional[Dict[int, float]] = None) -> List[Trade]:
    trades: List[Trade] = []
    if len(candles_5m) < 300: return trades
    candles_1h = aggregate_1h(candles_5m)
    n1h = len(candles_1h)
    if n1h < 60: return trades
    atr = atr_series(candles_1h, SWEEP_ATR_PERIOD)

    _htf_cache: dict = {}
    def _htf_at(bar_close_ts: int) -> str:
        if bar_close_ts in _htf_cache: return _htf_cache[bar_close_ts]
        sub = [c for c in candles_5m if c[TS] <= bar_close_ts]
        htf_4h = aggregate_4h(sub)
        st = "none" if len(htf_4h) < 20 else detect_htf_bos(htf_4h, tick=0.0).state
        _htf_cache[bar_close_ts] = st
        return st

    equity = STARTING_EQUITY
    open_pos: Optional[dict] = None

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

            # sample unrealized at bar low/high (worst point) for DD tracking
            adverse_px = lo if d == "long" else hi
            unreal_worst = (adverse_px - avg) * open_pos["filled_qty"] if d == "long" \
                           else (avg - adverse_px) * open_pos["filled_qty"]
            open_pos["min_unrealized"] = min(open_pos["min_unrealized"], unreal_worst)
            # bar-close unrealized (for portfolio agg alignment)
            unreal_close = (close_px - avg) * open_pos["filled_qty"] if d == "long" \
                           else (avg - close_px) * open_pos["filled_qty"]
            open_pos["bar_pnl"][int(bar[TS])] = unreal_close + open_pos["realized"]

            for ti, (frac, rr) in enumerate(TP_TIERS):
                if open_pos["tiers_hit"][ti]: continue
                tp_px = avg + rr * R if d == "long" else avg - rr * R
                hit_tp = (d == "long" and hi >= tp_px) or (d == "short" and lo <= tp_px)
                if hit_tp and open_pos["filled_qty"] > 0:
                    reduce_qty = open_pos["filled_qty"] * frac
                    gross = (tp_px - avg) * reduce_qty if d == "long" \
                            else (avg - tp_px) * reduce_qty
                    fees = (avg + tp_px) * reduce_qty * FEE
                    open_pos["realized"] += gross - fees
                    open_pos["closed_qty"] += reduce_qty
                    open_pos["tiers_hit"][ti] = True

            hit_stop = ((d == "long" and lo <= stop) or (d == "short" and hi >= stop))
            timed_out = (i - open_pos["entry_i"]) >= MAX_HOLD_BARS_1H
            all_tp = all(open_pos["tiers_hit"])
            if hit_stop or timed_out or all_tp:
                remaining = open_pos["filled_qty"] - open_pos["closed_qty"]
                exit_px = stop if hit_stop else close_px
                reason = "sweep_stop" if hit_stop else ("all_tp" if all_tp else "timeout")
                if remaining > 1e-12:
                    gross = (exit_px - avg) * remaining if d == "long" \
                            else (avg - exit_px) * remaining
                    fees = (avg + exit_px) * remaining * FEE
                    open_pos["realized"] += gross - fees
                equity += open_pos["realized"]
                trades.append(Trade(
                    symbol, d, variant_label,
                    open_pos["entry_ts"], bar[TS], avg, stop, reason,
                    open_pos["realized"], open_pos["rungs_filled"],
                    tuple(open_pos["tiers_hit"]),
                    open_pos["min_unrealized"], dict(open_pos["bar_pnl"]),
                ))
                open_pos = None
            else:
                continue

        window = candles_1h[: i + 1]
        atr_win = atr[: i + 1]
        htf_state = _htf_at(int(bar[TS]) + HOUR_MS - 1)
        r = detect_sweep(window, atr_win, htf_bos_state=htf_state, tick=0.0)
        if r is None: continue
        if r.direction == "long" and htf_state != "bullish_bos": continue
        if r.direction == "short" and htf_state != "bearish_bos": continue
        atr_now = atr_win[-1] or 0
        if atr_now <= 0: continue

        level = r.swept_level
        zone = ZONE_ATR_MULT * atr_now
        if zone <= 0: continue

        rung_prices: List[float] = []
        for k in range(RUNGS):
            frac = k / (RUNGS - 1) if RUNGS > 1 else 0.0
            px = level - frac * zone if r.direction == "long" else level + frac * zone
            rung_prices.append(px)
        deepest = rung_prices[-1]
        hard_stop = (deepest - buffer_atr * atr_now
                     if r.direction == "long"
                     else deepest + buffer_atr * atr_now)
        avg_if_full = sum(rung_prices) / RUNGS
        risk_dist = abs(avg_if_full - hard_stop)
        if risk_dist <= 0: continue

        if qty_mode == "match_c":
            key = int(bar[TS])
            if c_qty_by_ts is None or key not in c_qty_by_ts:
                continue  # no matched C signal — skip so signals stay aligned
            total_qty = c_qty_by_ts[key]
        else:
            total_qty = (equity * RISK_PER_TRADE) / risk_dist
            max_qty = (equity * LEVERAGE_CAP) / avg_if_full
            total_qty = min(total_qty, max_qty)
        if total_qty <= 0: continue
        qty_per_rung = total_qty / RUNGS

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
            "tiers_hit": [False, False, False], "pending": pending,
            "min_unrealized": 0.0, "bar_pnl": {},
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
    for t in sorted(trades, key=lambda x: x.exit_ts):
        eq += t.pnl_usd; peak = max(peak, eq); dd = min(dd, eq - peak)
    return {"trades": len(trades),
            "win_pct": 100.0 * len(wins) / len(trades),
            "avg_win": (sum(wins)/len(wins)) if wins else 0,
            "avg_loss": (sum(losses)/len(losses)) if losses else 0,
            "profit_factor": pf, "total_return": total, "max_dd": dd}


def _portfolio_worst_open_dd(trades_by_symbol: Dict[str, List[Trade]]) -> float:
    """Worst summed unrealized $ across all symbols at any 1h bar."""
    agg: Dict[int, float] = {}
    for sym_trs in trades_by_symbol.values():
        for t in sym_trs:
            for ts, upnl in t.bar_pnl.items():
                # take only the *unrealized* component drift, not realized
                # bar_pnl stores unrealized+realized; use it as-is: the sum
                # across concurrent OPEN positions is the portfolio unrealized
                # (realized-so-far portions are locked and don't drift).
                agg[ts] = agg.get(ts, 0.0) + upnl
    if not agg: return 0.0
    return min(agg.values())


def main():
    bars = HORIZON_DAYS * BARS_PER_DAY
    all_5m: Dict[str, List[list]] = {}
    src: Dict[str, str] = {}
    for sym in SYMBOLS:
        c = _fetch_bybit(sym, bars)
        src[sym] = "bybit_proxy" if c else "unavailable"
        all_5m[sym] = c or []

    # PASS 1: run C to build per-signal qty map { (symbol, entry_ts): total_qty }
    per_variant: Dict[str, List[Trade]] = {}
    per_variant_by_symbol: Dict[str, Dict[str, List[Trade]]] = {}

    # C first
    c_label, c_buf, _ = VARIANTS[0]
    c_qty_by_symbol: Dict[str, Dict[int, float]] = {}
    c_trades: List[Trade] = []
    c_by_sym: Dict[str, List[Trade]] = {}
    for sym in SYMBOLS:
        if not all_5m[sym]: continue
        tr = _simulate(sym, all_5m[sym], c_buf, "risk", c_label)
        # per-signal qty for match_c lookup
        m: Dict[int, float] = {}
        for t in tr:
            # infer qty from filled_notional/avg is unavailable here; instead
            # recover total_qty from sum of tiers_hit info — cleaner: re-derive
            # from stored avg_entry & risk. Simpler: store on trade. We didn't;
            # workaround: recompute during simulate. Easier: recompute a second
            # C pass just to log qty. For determinism we recompute here from
            # (equity, risk_dist). Approx equity=STARTING (matches match_c
            # variants which don't compound either).
            pass
        c_trades.extend(tr)
        c_by_sym[sym] = tr
    per_variant[c_label] = c_trades
    per_variant_by_symbol[c_label] = c_by_sym

    # Because we didn't record total_qty per trade, re-run C but capturing qty.
    # Do the qty capture via an instrumented rerun:
    def _capture_c_qty(symbol: str, candles_5m: List[list]) -> Dict[int, float]:
        out: Dict[int, float] = {}
        if len(candles_5m) < 300: return out
        c1h = aggregate_1h(candles_5m)
        n = len(c1h)
        if n < 60: return out
        a = atr_series(c1h, SWEEP_ATR_PERIOD)
        _cache: dict = {}
        def _h(ts_):
            if ts_ in _cache: return _cache[ts_]
            sub = [x for x in candles_5m if x[TS] <= ts_]
            h4 = aggregate_4h(sub)
            st = "none" if len(h4) < 20 else detect_htf_bos(h4, tick=0.0).state
            _cache[ts_] = st; return st
        eq = STARTING_EQUITY
        for i in range(60, n):
            bar = c1h[i]
            hs = _h(int(bar[TS]) + HOUR_MS - 1)
            r = detect_sweep(c1h[:i+1], a[:i+1], htf_bos_state=hs, tick=0.0)
            if r is None: continue
            if r.direction == "long" and hs != "bullish_bos": continue
            if r.direction == "short" and hs != "bearish_bos": continue
            atr_now = a[i] or 0
            if atr_now <= 0: continue
            level = r.swept_level
            zone = ZONE_ATR_MULT * atr_now
            rp = []
            for k in range(RUNGS):
                fr = k / (RUNGS - 1) if RUNGS > 1 else 0.0
                px = level - fr*zone if r.direction == "long" else level + fr*zone
                rp.append(px)
            deep = rp[-1]
            hs_px = deep - c_buf*atr_now if r.direction=="long" else deep + c_buf*atr_now
            avg_full = sum(rp)/RUNGS
            rd = abs(avg_full - hs_px)
            if rd <= 0: continue
            tq = (eq * RISK_PER_TRADE) / rd
            mq = (eq * LEVERAGE_CAP) / avg_full
            out[int(bar[TS])] = min(tq, mq)
        return out

    for sym in SYMBOLS:
        if not all_5m[sym]: continue
        c_qty_by_symbol[sym] = _capture_c_qty(sym, all_5m[sym])

    # PASS 2: run E, F, E2, F2
    for label, buf, mode in VARIANTS[1:]:
        by_sym: Dict[str, List[Trade]] = {}
        allt: List[Trade] = []
        for sym in SYMBOLS:
            if not all_5m[sym]: continue
            qty_map = c_qty_by_symbol.get(sym) if mode == "match_c" else None
            tr = _simulate(sym, all_5m[sym], buf, mode, label, qty_map)
            by_sym[sym] = tr
            allt.extend(tr)
        per_variant[label] = allt
        per_variant_by_symbol[label] = by_sym

    print(f"\nsymbols     : {SYMBOLS}")
    print(f"data source : {src}")
    print(f"horizon     : {HORIZON_DAYS}d   equity: ${STARTING_EQUITY}   "
          f"lev cap: {LEVERAGE_CAP}x   risk/trade (C/E/F): {RISK_PER_TRADE*100:.1f}%")
    print(f"ladder: 4r x 1.0xATR zone.  4h HTF ACTIVE.  TP 50/30/20 @ 1.75/2.0/2.5R.  "
          f"timeout {MAX_HOLD_BARS_1H} 1h bars.")
    print(f"variants: C=buf0.25xATR   E=buf1.0xATR   F=buf2.0xATR   "
          f"E2/F2 = same qty as C (higher effective risk).")

    print("\n=== HEAD-TO-HEAD ===")
    hdr = (f"{'variant':<20} {'#':>4}  {'win%':>6}  {'avgW':>8}  "
           f"{'avgL':>8}  {'PF':>6}  {'maxDD':>9}  {'totRet':>10}")
    print(hdr); print("-" * len(hdr))
    for label, _, _ in VARIANTS:
        m = _metrics(per_variant[label])
        print(f"{label:<20} {m['trades']:>4}  {m['win_pct']:>5.1f}%  "
              f"{m['avg_win']:>+8.2f}  {m['avg_loss']:>+8.2f}  "
              f"{m['profit_factor']:>6.2f}  {m['max_dd']:>+9.2f}  "
              f"{m['total_return']:>+10.2f}")

    # Recovery analysis vs C's sweep_stop trades
    c_stopouts = [t for t in per_variant[c_label] if t.exit_reason == "sweep_stop"]
    c_keys = {(t.symbol, t.entry_ts) for t in c_stopouts}
    print(f"\n=== RECOVERY OF C's {len(c_stopouts)} sweep_stop TRADES UNDER WIDER STOPS ===")
    print(f"{'variant':<20} {'matched':>8} {'recovered>0':>12} {'still_stop':>11} "
          f"{'timeout':>9} {'all_tp':>8}  {'sum_pnl_on_matched':>20}")
    print("-" * 92)
    for label, _, _ in VARIANTS[1:]:
        trs = [t for t in per_variant[label] if (t.symbol, t.entry_ts) in c_keys]
        matched = len(trs)
        recov = sum(1 for t in trs if t.pnl_usd > 0)
        still = sum(1 for t in trs if t.exit_reason == "sweep_stop")
        tmo   = sum(1 for t in trs if t.exit_reason == "timeout")
        atp   = sum(1 for t in trs if t.exit_reason == "all_tp")
        pnl   = sum(t.pnl_usd for t in trs)
        print(f"{label:<20} {matched:>8} {recov:>12} {still:>11} "
              f"{tmo:>9} {atp:>8}  {pnl:>+20.2f}")

    print("\n=== PER-VARIANT LADDER / TIER / DD ===")
    for label, buf, _ in VARIANTS:
        tr = per_variant[label]
        n = len(tr)
        if n == 0:
            print(f"\n{label}: no trades"); continue
        avg_rungs = sum(t.rungs_filled for t in tr) / n
        all_full = sum(1 for t in tr if t.rungs_filled >= RUNGS)
        stopped_full = sum(1 for t in tr if t.rungs_filled >= RUNGS and t.exit_reason == "sweep_stop")
        t1 = sum(1 for t in tr if t.tiers_hit[0])
        t2 = sum(1 for t in tr if t.tiers_hit[1])
        t3 = sum(1 for t in tr if t.tiers_hit[2])
        rmix = {"sweep_stop":0,"all_tp":0,"timeout":0}
        for t in tr: rmix[t.exit_reason] = rmix.get(t.exit_reason,0)+1
        stopouts = [t for t in tr if t.exit_reason == "sweep_stop"]
        avg_stop_dd = (sum(t.pnl_usd for t in stopouts)/len(stopouts)) if stopouts else 0
        worst_hold_dd = min((t.min_unrealized for t in tr), default=0)
        print(f"\n{label}  (buf {buf}xATR)")
        print(f"  avg rungs filled / trade : {avg_rungs:.2f} / {RUNGS}")
        print(f"  % trades all rungs filled: {100.0*all_full/n:.1f}% ({all_full}/{n})")
        print(f"  % stopped at full ladder : {100.0*stopped_full/n:.1f}% ({stopped_full}/{n})")
        print(f"  tier hits TP1/TP2/TP3    : {100.0*t1/n:>5.1f}% / {100.0*t2/n:>5.1f}% / {100.0*t3/n:>5.1f}%")
        print(f"  exits sweep/all_tp/tmout : {rmix['sweep_stop']} / {rmix['all_tp']} / {rmix['timeout']}")
        print(f"  avg $ loss on stop-outs  : {avg_stop_dd:+.2f}")
        print(f"  worst intrabar unreal $  : {worst_hold_dd:+.2f}  (single-trade)")

    print("\n=== PORTFOLIO SIMULTANEOUS OPEN DRAWDOWN (sum across 5 symbols, 1h bars) ===")
    print(f"{'variant':<20} {'worst_summed_open_pnl_$':>28}")
    for label, _, _ in VARIANTS:
        w = _portfolio_worst_open_dd(per_variant_by_symbol[label])
        print(f"{label:<20} {w:>+28.2f}")


if __name__ == "__main__":
    main()
