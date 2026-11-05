"""10-day DELAYED-SNIPER ladder harness — HARNESS ONLY.

Same signals, same window, same everything except rung geometry.

C) BASELINE (current leader):  1.0xATR zone, 4 rungs evenly from the level
     rung fractions of zone = 0.00, 0.333, 0.667, 1.00
G) DELAYED SNIPER:             1.0xATR zone, NO rung at the level
     rung fractions of zone = 0.25, 0.50, 0.75, 1.00
     (equal margin, hard stop = deepest + 0.25xATR — same buffer as C)

Reports head-to-head, ladder stats, PLUS:
  * C-only trades (no fill under G, i.e. fakeouts G skipped) with their C-PnL
  * avg-entry improvement on trades both variants took

No production files touched. Data source: Bybit 5m proxy.
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
BUFFER_ATR = 0.25
HOUR_MS = 60 * 60 * 1000

# variant fraction sets (of zone, beyond level, in the adverse direction)
FRACS_C = [0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0]
FRACS_G = [0.25, 0.50, 0.75, 1.00]

VARIANTS = [
    ("C_evenFromLevel", FRACS_C),
    ("G_delayedSniper", FRACS_G),
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


def _simulate(symbol: str, candles_5m: List[list], fracs: List[float],
              variant_label: str) -> List[Trade]:
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
        for f in fracs:
            px = level - f * zone if r.direction == "long" else level + f * zone
            rung_prices.append(px)
        deepest = rung_prices[-1]
        hard_stop = (deepest - BUFFER_ATR * atr_now
                     if r.direction == "long"
                     else deepest + BUFFER_ATR * atr_now)
        avg_if_full = sum(rung_prices) / len(rung_prices)
        risk_dist = abs(avg_if_full - hard_stop)
        if risk_dist <= 0: continue

        total_qty = (equity * RISK_PER_TRADE) / risk_dist
        max_qty = (equity * LEVERAGE_CAP) / avg_if_full
        total_qty = min(total_qty, max_qty)
        if total_qty <= 0: continue
        qty_per_rung = total_qty / len(rung_prices)

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
        if filled_qty <= 0:
            # G-specific: no fill on entry bar → trade is skipped entirely.
            # (Signal is discarded; we do NOT keep it pending across bars,
            # matching the harness convention used across prior variant runs.)
            continue
        avg_entry = filled_notional / filled_qty
        open_pos = {
            "direction": r.direction, "avg_entry": avg_entry,
            "hard_stop": hard_stop, "filled_qty": filled_qty,
            "filled_notional": filled_notional, "closed_qty": 0.0,
            "realized": -filled_notional * FEE,
            "entry_i": i, "entry_ts": bar[TS], "rungs_filled": rungs_filled,
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
    for t in sorted(trades, key=lambda x: x.exit_ts):
        eq += t.pnl_usd; peak = max(peak, eq); dd = min(dd, eq - peak)
    return {"trades": len(trades),
            "win_pct": 100.0 * len(wins) / len(trades),
            "avg_win": (sum(wins)/len(wins)) if wins else 0,
            "avg_loss": (sum(losses)/len(losses)) if losses else 0,
            "profit_factor": pf, "total_return": total, "max_dd": dd}


def _ladder_stats(trades: List[Trade]) -> dict:
    if not trades: return {"avg_rungs": 0, "pct_all": 0, "pct_stopped_full": 0,
                            "tp1": 0, "tp2": 0, "tp3": 0,
                            "exit_stop": 0, "exit_timeout": 0, "exit_all_tp": 0}
    n = len(trades)
    avg_rungs = sum(t.rungs_filled for t in trades) / n
    pct_all = 100.0 * sum(1 for t in trades if t.rungs_filled == RUNGS) / n
    full_stops = sum(1 for t in trades if t.exit_reason == "sweep_stop" and t.rungs_filled == RUNGS)
    return {
        "avg_rungs": avg_rungs,
        "pct_all": pct_all,
        "pct_stopped_full": 100.0 * full_stops / n,
        "tp1": 100.0 * sum(1 for t in trades if t.tiers_hit[0]) / n,
        "tp2": 100.0 * sum(1 for t in trades if t.tiers_hit[1]) / n,
        "tp3": 100.0 * sum(1 for t in trades if t.tiers_hit[2]) / n,
        "exit_stop": 100.0 * sum(1 for t in trades if t.exit_reason == "sweep_stop") / n,
        "exit_timeout": 100.0 * sum(1 for t in trades if t.exit_reason == "timeout") / n,
        "exit_all_tp": 100.0 * sum(1 for t in trades if t.exit_reason == "all_tp") / n,
    }


def main():
    bars = HORIZON_DAYS * BARS_PER_DAY
    all_5m: Dict[str, List[list]] = {}
    src: Dict[str, str] = {}
    for sym in SYMBOLS:
        c = _fetch_bybit(sym, bars)
        src[sym] = "bybit_proxy" if c else "unavailable"
        all_5m[sym] = c or []

    per_variant: Dict[str, List[Trade]] = {}
    for label, fracs in VARIANTS:
        allt: List[Trade] = []
        for sym in SYMBOLS:
            if not all_5m[sym]: continue
            allt.extend(_simulate(sym, all_5m[sym], fracs, label))
        per_variant[label] = allt

    print(f"\nsymbols     : {SYMBOLS}")
    print(f"data source : {src}")
    print(f"horizon     : {HORIZON_DAYS}d   equity: ${STARTING_EQUITY}   "
          f"lev cap: {LEVERAGE_CAP}x   risk/trade: {RISK_PER_TRADE*100:.1f}%")
    print(f"ladder: 4r x 1.0xATR zone. 4h HTF ACTIVE. buffer 0.25xATR. "
          f"TP 50/30/20 @ 1.75/2.0/2.5R. timeout {MAX_HOLD_BARS_1H} 1h bars.")
    print(f"C rung fracs of zone: {FRACS_C}")
    print(f"G rung fracs of zone: {FRACS_G}")

    print("\n=== HEAD-TO-HEAD ===")
    hdr = (f"{'variant':<20} {'#':>4}  {'win%':>6}  {'avgW':>8}  "
           f"{'avgL':>8}  {'PF':>6}  {'maxDD':>9}  {'totRet':>10}")
    print(hdr); print("-" * len(hdr))
    for label, _ in VARIANTS:
        m = _metrics(per_variant[label])
        print(f"{label:<20} {m['trades']:>4}  {m['win_pct']:>5.1f}%  "
              f"{m['avg_win']:>+8.2f}  {m['avg_loss']:>+8.2f}  "
              f"{m['profit_factor']:>6.2f}  {m['max_dd']:>+9.2f}  "
              f"{m['total_return']:>+10.2f}")

    print("\n=== LADDER STATS ===")
    hdr2 = (f"{'variant':<20} {'avgRungs':>9}  {'%all':>6}  {'%stFull':>8}  "
            f"{'tp1%':>6}  {'tp2%':>6}  {'tp3%':>6}  "
            f"{'stop%':>6}  {'to%':>6}  {'allTP%':>7}")
    print(hdr2); print("-" * len(hdr2))
    for label, _ in VARIANTS:
        s = _ladder_stats(per_variant[label])
        print(f"{label:<20} {s['avg_rungs']:>9.2f}  {s['pct_all']:>5.1f}%  "
              f"{s['pct_stopped_full']:>7.1f}%  "
              f"{s['tp1']:>5.1f}%  {s['tp2']:>5.1f}%  {s['tp3']:>5.1f}%  "
              f"{s['exit_stop']:>5.1f}%  {s['exit_timeout']:>5.1f}%  "
              f"{s['exit_all_tp']:>6.1f}%")

    # ── KEY DELTA ───────────────────────────────────────────────────────────
    # trades C took but G did not (shallow fakeouts G skipped by design)
    c_keys = {(t.symbol, t.entry_ts): t for t in per_variant["C_evenFromLevel"]}
    g_keys = {(t.symbol, t.entry_ts): t for t in per_variant["G_delayedSniper"]}
    only_c_keys = set(c_keys) - set(g_keys)
    shared_keys = set(c_keys) & set(g_keys)
    only_g_keys = set(g_keys) - set(c_keys)

    print(f"\n=== KEY DELTA: C-only trades (G skipped, no rung filled) ===")
    print(f"trades taken by C only : {len(only_c_keys)}")
    print(f"trades taken by G only : {len(only_g_keys)}   "
          f"(should be ~0; G's fills are a subset of C's signal set)")
    print(f"trades taken by both   : {len(shared_keys)}")

    only_c_trades = [c_keys[k] for k in only_c_keys]
    if only_c_trades:
        total = sum(t.pnl_usd for t in only_c_trades)
        wins = [t for t in only_c_trades if t.pnl_usd > 0]
        losses = [t for t in only_c_trades if t.pnl_usd <= 0]
        print(f"\nC-only trades PnL summary:")
        print(f"  count={len(only_c_trades)}  wins={len(wins)}  losses={len(losses)}  "
              f"totalPnL(under C) = {total:+.2f}")
        print(f"\n  (per-trade — what skipping the level-touch rung cost or saved)")
        print(f"  {'sym':<10} {'dir':<6} {'entry_ts':<15} {'reason':<12} {'pnl':>9}")
        for t in sorted(only_c_trades, key=lambda x: x.pnl_usd):
            print(f"  {t.symbol:<10} {t.direction:<6} {t.entry_ts:<15} "
                  f"{t.exit_reason:<12} {t.pnl_usd:>+9.2f}")
    else:
        print("  (none — G filled on every signal C did)")

    # avg-entry improvement on shared trades
    if shared_keys:
        print(f"\n=== AVG-ENTRY IMPROVEMENT on {len(shared_keys)} shared trades ===")
        improvements_pct: List[float] = []
        for k in shared_keys:
            ct = c_keys[k]; gt = g_keys[k]
            if ct.direction == "long":
                # deeper (lower) entry is better for long
                imp = (ct.avg_entry - gt.avg_entry) / ct.avg_entry * 100.0
            else:
                # deeper (higher) entry is better for short
                imp = (gt.avg_entry - ct.avg_entry) / ct.avg_entry * 100.0
            improvements_pct.append(imp)
        avg_imp = sum(improvements_pct) / len(improvements_pct)
        pos = sum(1 for x in improvements_pct if x > 0)
        neg = sum(1 for x in improvements_pct if x < 0)
        print(f"  avg improvement (%) : {avg_imp:+.3f}%   "
              f"(positive = G's avg entry is deeper/better)")
        print(f"  better under G      : {pos} / {len(shared_keys)}")
        print(f"  worse under G       : {neg} / {len(shared_keys)}")
        # PnL delta on shared
        c_shared_pnl = sum(c_keys[k].pnl_usd for k in shared_keys)
        g_shared_pnl = sum(g_keys[k].pnl_usd for k in shared_keys)
        print(f"  shared-trade totRet : C={c_shared_pnl:+.2f}   "
              f"G={g_shared_pnl:+.2f}   Δ={g_shared_pnl - c_shared_pnl:+.2f}")


if __name__ == "__main__":
    main()
