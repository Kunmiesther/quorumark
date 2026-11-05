"""30-day PYRAMID ladder harness — HARNESS ONLY.

C) BASELINE:  1.0xATR zone, 4 evenly-spaced rungs from level, equal weight.
H) PYRAMID:   1.0xATR zone, 3 fill depths [0.0, 0.5, 1.0] with weights
              1/6, 2/6, 3/6 (deepest carries the most).
              Total margin/risk envelope identical to C (2% risk).
              Stop = zone_edge + 0.25xATR buffer.

Reports head-to-head, ladder stats, plus:
  * avg entry depth (%) vs C on shared trades
  * PnL on H-trades where the 3-unit deep (edge) rung filled
  * portfolio concurrent-drawdown per variant (summed unrealized+realized).

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
HORIZON_DAYS = 30
SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "DOGE-USDT", "XRP-USDT"]
STARTING_EQUITY = 1000.0
RISK_PER_TRADE = 0.02
LEVERAGE_CAP = 20
FEE = 0.0004
MAX_HOLD_BARS_1H = 48
TP_TIERS = [(0.50, 1.75), (0.30, 2.0), (0.20, 2.5)]
ZONE_ATR_MULT = 1.0
BUFFER_ATR = 0.25
HOUR_MS = 60 * 60 * 1000

# variant defs: (label, fracs-of-zone, weights summing to 1.0, unit_count)
FRACS_C = [0.0, 1/3, 2/3, 1.0]
WEIGHTS_C = [0.25, 0.25, 0.25, 0.25]
FRACS_H = [0.0, 0.5, 1.0]
WEIGHTS_H = [1/6, 2/6, 3/6]
FRACS_H2 = [0.0, 0.5, 1.0]
WEIGHTS_H2 = [1/6, 3/6, 2/6]   # mid-weighted: 1u level / 3u mid / 2u edge
UNITS_C = 4     # rung count (each = 1 unit)
UNITS_H = 6     # rung-units total (1+2+3)
UNITS_H2 = 6    # rung-units total (1+3+2)
UNIT_WEIGHTS_H = [1, 2, 3]  # per-rung "units" for filled-units accounting
UNIT_WEIGHTS_H2 = [1, 3, 2]

VARIANTS = [
    ("C_evenFromLevel", FRACS_C, WEIGHTS_C, UNITS_C, None),
    ("H_pyramid",       FRACS_H, WEIGHTS_H, UNITS_H, UNIT_WEIGHTS_H),
    ("H2_midWeighted",  FRACS_H2, WEIGHTS_H2, UNITS_H2, UNIT_WEIGHTS_H2),
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
            data = json.loads(urllib.request.urlopen(url, timeout=15).read())
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
    rungs_filled: int = 0          # count of distinct rung levels filled
    units_filled: float = 0.0      # weighted units (C: same as rungs, H: 1/2/3)
    edge_filled: bool = False      # H-only: did deepest (3-unit) fill?
    tiers_hit: Tuple[bool, bool, bool] = (False, False, False)
    # per-bar unrealized samples for portfolio DD:  list of (ts, uPnL)
    mtm_curve: List[Tuple[int, float]] = field(default_factory=list)


def _simulate(symbol: str, candles_5m: List[list],
              fracs: List[float], weights: List[float],
              unit_count: int, unit_weights: Optional[List[int]],
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
            for rung_px, rung_qty, rung_units, is_edge in open_pos["pending"]:
                hit = (d == "long" and lo <= rung_px) or (d == "short" and hi >= rung_px)
                if hit:
                    open_pos["filled_qty"] += rung_qty
                    open_pos["filled_notional"] += rung_qty * rung_px
                    open_pos["rungs_filled"] += 1
                    open_pos["units_filled"] += rung_units
                    if is_edge: open_pos["edge_filled"] = True
                else:
                    still.append((rung_px, rung_qty, rung_units, is_edge))
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

            # mtm sample at bar close for portfolio DD
            live_qty = open_pos["filled_qty"] - open_pos["closed_qty"]
            uPnL = 0.0
            if live_qty > 1e-12:
                if d == "long":
                    uPnL = (close_px - avg) * live_qty
                else:
                    uPnL = (avg - close_px) * live_qty
            open_pos["mtm_curve"].append((int(bar[TS]), open_pos["realized"] + uPnL))

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
                    open_pos["units_filled"], open_pos["edge_filled"],
                    tuple(open_pos["tiers_hit"]),
                    open_pos["mtm_curve"],
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
        # hard stop pinned to zone-edge (deepest possible rung), not just deepest listed
        edge_px = rung_prices[-1]
        hard_stop = (edge_px - BUFFER_ATR * atr_now
                     if r.direction == "long"
                     else edge_px + BUFFER_ATR * atr_now)

        # weighted avg-if-full for sizing
        avg_if_full = sum(px * w for px, w in zip(rung_prices, weights))
        risk_dist = abs(avg_if_full - hard_stop)
        if risk_dist <= 0: continue

        total_qty = (equity * RISK_PER_TRADE) / risk_dist
        max_qty = (equity * LEVERAGE_CAP) / avg_if_full
        total_qty = min(total_qty, max_qty)
        if total_qty <= 0: continue

        # per-rung qty from weights
        rung_qtys = [total_qty * w for w in weights]
        # unit tags for filled-units accounting
        if unit_weights is None:
            rung_units_list = [1] * len(rung_prices)
        else:
            rung_units_list = unit_weights

        filled_qty = 0.0; filled_notional = 0.0
        rungs_filled = 0; units_filled = 0.0; edge_filled = False
        pending: List[Tuple[float, float, int, bool]] = []
        last_idx = len(rung_prices) - 1
        for idx, (px, q, u) in enumerate(zip(rung_prices, rung_qtys, rung_units_list)):
            is_edge = (idx == last_idx)
            hit = (r.direction == "long" and lo <= px) or (r.direction == "short" and hi >= px)
            if hit:
                filled_qty += q
                filled_notional += q * px
                rungs_filled += 1
                units_filled += u
                if is_edge: edge_filled = True
            else:
                pending.append((px, q, u, is_edge))
        if filled_qty <= 0:
            continue
        avg_entry = filled_notional / filled_qty
        open_pos = {
            "direction": r.direction, "avg_entry": avg_entry,
            "hard_stop": hard_stop, "filled_qty": filled_qty,
            "filled_notional": filled_notional, "closed_qty": 0.0,
            "realized": -filled_notional * FEE,
            "entry_i": i, "entry_ts": bar[TS], "rungs_filled": rungs_filled,
            "units_filled": units_filled, "edge_filled": edge_filled,
            "tiers_hit": [False, False, False], "pending": pending,
            "mtm_curve": [],
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


def _ladder_stats(trades: List[Trade], unit_count: int,
                  unit_weights: Optional[List[int]]) -> dict:
    if not trades:
        return {"avg_units": 0, "pct_l1": 0, "pct_l2": 0, "pct_l3": 0,
                "pct_all": 0, "pct_stopped_full": 0,
                "tp1": 0, "tp2": 0, "tp3": 0,
                "exit_stop": 0, "exit_timeout": 0, "exit_all_tp": 0}
    n = len(trades)
    avg_units = sum(t.units_filled for t in trades) / n
    # depth thresholds: for C we treat "l1/l2/l3" as reaching rungs 2/3/4
    # for H they are the 1u/2u/3u depths
    if unit_weights is None:
        pct_l1 = 100.0 * sum(1 for t in trades if t.rungs_filled >= 2) / n
        pct_l2 = 100.0 * sum(1 for t in trades if t.rungs_filled >= 3) / n
        pct_l3 = 100.0 * sum(1 for t in trades if t.rungs_filled >= 4) / n
    else:
        pct_l1 = 100.0 * sum(1 for t in trades if t.rungs_filled >= 1) / n
        pct_l2 = 100.0 * sum(1 for t in trades if t.rungs_filled >= 2) / n
        pct_l3 = 100.0 * sum(1 for t in trades if t.rungs_filled >= 3) / n
    pct_all = 100.0 * sum(1 for t in trades if t.units_filled >= unit_count - 1e-9) / n
    full_stops = sum(1 for t in trades
                     if t.exit_reason == "sweep_stop"
                     and t.units_filled >= unit_count - 1e-9)
    return {
        "avg_units": avg_units,
        "pct_l1": pct_l1, "pct_l2": pct_l2, "pct_l3": pct_l3,
        "pct_all": pct_all,
        "pct_stopped_full": 100.0 * full_stops / n,
        "tp1": 100.0 * sum(1 for t in trades if t.tiers_hit[0]) / n,
        "tp2": 100.0 * sum(1 for t in trades if t.tiers_hit[1]) / n,
        "tp3": 100.0 * sum(1 for t in trades if t.tiers_hit[2]) / n,
        "exit_stop": 100.0 * sum(1 for t in trades if t.exit_reason == "sweep_stop") / n,
        "exit_timeout": 100.0 * sum(1 for t in trades if t.exit_reason == "timeout") / n,
        "exit_all_tp": 100.0 * sum(1 for t in trades if t.exit_reason == "all_tp") / n,
    }


def _portfolio_concurrent_dd(trades: List[Trade]) -> Tuple[float, float]:
    """Returns (worst_summed_open_drawdown, worst_total_equity_drawdown).

    Reconstructs a portfolio equity curve on the union of all 1h bar timestamps.
    Between samples the position's cumulative (realized+unrealized) is carried
    forward (step function). Worst summed open DD = min of (sum of open uPnL only)
    across the timeline; total equity DD = min of (portfolio equity - running peak).
    """
    if not trades: return (0.0, 0.0)
    # gather all sample timestamps
    all_ts = sorted({ts for t in trades for ts, _ in t.mtm_curve})
    if not all_ts: return (0.0, 0.0)
    # per trade, index by ts + track when it exits (last sample or exit_ts)
    per_trade = []
    for t in trades:
        curve = dict(t.mtm_curve)  # ts -> realized+unrealized while open
        per_trade.append((t.entry_ts, t.exit_ts, t.pnl_usd, curve, t))

    portfolio_eq = STARTING_EQUITY
    peak = portfolio_eq
    worst_open_only = 0.0
    worst_eq_dd = 0.0
    realized_locked = 0.0
    # we walk in ts order; open contribution at each sample = curve[ts] for open trades
    # once trade exits (ts > exit_ts) we lock realized into realized_locked once.
    locked_ids = set()
    for ts in all_ts:
        # lock realized for any trade whose exit_ts < ts
        for idx, (ets, xts, pnl, curve, t) in enumerate(per_trade):
            if idx in locked_ids: continue
            if xts < ts:
                realized_locked += pnl
                locked_ids.add(idx)
        # open contribution: for trades where ets<=ts<=xts, use curve.get(ts, last<=ts)
        open_sum = 0.0
        for idx, (ets, xts, pnl, curve, t) in enumerate(per_trade):
            if ets <= ts <= xts and idx not in locked_ids:
                if ts in curve:
                    open_sum += curve[ts]
                else:
                    # find latest sample <=ts within this trade
                    latest = None
                    for k, v in curve.items():
                        if k <= ts and (latest is None or k > latest[0]):
                            latest = (k, v)
                    if latest is not None:
                        open_sum += latest[1]
        eq = STARTING_EQUITY + realized_locked + open_sum
        peak = max(peak, eq)
        worst_eq_dd = min(worst_eq_dd, eq - peak)
        # open-only DD ignores realized (pure position stress)
        # approximate open_only = open_sum minus locked realized components already
        # already excluded by construction (locked trades not counted here)
        worst_open_only = min(worst_open_only, open_sum)
    return (worst_open_only, worst_eq_dd)


def main():
    bars = HORIZON_DAYS * BARS_PER_DAY
    all_5m: Dict[str, List[list]] = {}
    src: Dict[str, str] = {}
    for sym in SYMBOLS:
        c = _fetch_bybit(sym, bars)
        src[sym] = "bybit_proxy" if c else "unavailable"
        all_5m[sym] = c or []

    per_variant: Dict[str, List[Trade]] = {}
    for label, fracs, weights, unit_count, unit_weights in VARIANTS:
        allt: List[Trade] = []
        for sym in SYMBOLS:
            if not all_5m[sym]: continue
            allt.extend(_simulate(sym, all_5m[sym], fracs, weights,
                                  unit_count, unit_weights, label))
        per_variant[label] = allt

    print(f"\nsymbols     : {SYMBOLS}")
    print(f"data source : {src}")
    print(f"horizon     : {HORIZON_DAYS}d   equity: ${STARTING_EQUITY}   "
          f"lev cap: {LEVERAGE_CAP}x   risk/trade: {RISK_PER_TRADE*100:.1f}%")
    print(f"ladder: 1.0xATR zone, 4h HTF ACTIVE, buffer 0.25xATR, "
          f"TP 50/30/20 @ 1.75/2.0/2.5R, timeout {MAX_HOLD_BARS_1H} 1h bars.")
    print(f"C: rungs @ fracs {[round(x,3) for x in FRACS_C]}, equal weight (4 units).")
    print(f"H: rungs @ fracs {FRACS_H}, weights {['1/6','2/6','3/6']} (6 units, edge=deepest).")
    print(f"H2: rungs @ fracs {FRACS_H2}, weights {['1/6','3/6','2/6']} (6 units, edge=deepest).")

    print("\n=== HEAD-TO-HEAD ===")
    hdr = (f"{'variant':<20} {'#':>4}  {'win%':>6}  {'avgW':>8}  "
           f"{'avgL':>8}  {'PF':>6}  {'maxDD':>9}  {'totRet':>10}")
    print(hdr); print("-" * len(hdr))
    for label, *_ in VARIANTS:
        m = _metrics(per_variant[label])
        pf_s = f"{m['profit_factor']:>6.2f}" if m['profit_factor'] != math.inf else "   inf"
        print(f"{label:<20} {m['trades']:>4}  {m['win_pct']:>5.1f}%  "
              f"{m['avg_win']:>+8.2f}  {m['avg_loss']:>+8.2f}  "
              f"{pf_s}  {m['max_dd']:>+9.2f}  {m['total_return']:>+10.2f}")

    print("\n=== LADDER / DEPTH STATS ===")
    hdr2 = (f"{'variant':<20} {'avgU':>6}  {'%d1':>6}  {'%d2':>6}  {'%d3':>6}  "
            f"{'%all':>6}  {'%stFull':>8}  "
            f"{'tp1%':>6}  {'tp2%':>6}  {'tp3%':>6}  "
            f"{'stop%':>6}  {'to%':>6}  {'allTP%':>7}")
    print(hdr2); print("-" * len(hdr2))
    for label, _f, _w, uc, uw in VARIANTS:
        s = _ladder_stats(per_variant[label], uc, uw)
        print(f"{label:<20} {s['avg_units']:>6.2f}  "
              f"{s['pct_l1']:>5.1f}%  {s['pct_l2']:>5.1f}%  {s['pct_l3']:>5.1f}%  "
              f"{s['pct_all']:>5.1f}%  {s['pct_stopped_full']:>7.1f}%  "
              f"{s['tp1']:>5.1f}%  {s['tp2']:>5.1f}%  {s['tp3']:>5.1f}%  "
              f"{s['exit_stop']:>5.1f}%  {s['exit_timeout']:>5.1f}%  "
              f"{s['exit_all_tp']:>6.1f}%")
    print("  (d1/d2/d3 = trades reaching 1st/2nd/3rd fill DEPTH; %all = all units filled)")

    # ── shared-trade avg-entry depth ────────────────────────────────────────
    def _shared_depth_report(a_label: str, b_label: str) -> None:
        a_keys = {(t.symbol, t.entry_ts): t for t in per_variant[a_label]}
        b_keys = {(t.symbol, t.entry_ts): t for t in per_variant[b_label]}
        shared = set(a_keys) & set(b_keys)
        only_a = set(a_keys) - set(b_keys)
        only_b = set(b_keys) - set(a_keys)
        print(f"\n=== SHARED TRADES ({len(shared)}) — {b_label} vs {a_label} ===")
        print(f"{a_label}-only: {len(only_a)}   {b_label}-only: {len(only_b)}")
        if not shared: return
        deltas = []; a_pnl = 0.0; b_pnl = 0.0
        for k in shared:
            at = a_keys[k]; bt = b_keys[k]
            if at.direction == "long":
                imp = (at.avg_entry - bt.avg_entry) / at.avg_entry * 100.0
            else:
                imp = (bt.avg_entry - at.avg_entry) / at.avg_entry * 100.0
            deltas.append(imp); a_pnl += at.pnl_usd; b_pnl += bt.pnl_usd
        avg_imp = sum(deltas) / len(deltas)
        pos = sum(1 for x in deltas if x > 0); neg = sum(1 for x in deltas if x < 0)
        print(f"  avg entry-depth improvement : {avg_imp:+.3f}%   "
              f"(positive = {b_label} entered deeper)")
        print(f"  deeper under {b_label:<15}: {pos}/{len(shared)}")
        print(f"  worse  under {b_label:<15}: {neg}/{len(shared)}")
        print(f"  shared-trade totRet         : {a_label}={a_pnl:+.2f}  "
              f"{b_label}={b_pnl:+.2f}  Δ={b_pnl - a_pnl:+.2f}")

    _shared_depth_report("C_evenFromLevel", "H_pyramid")
    _shared_depth_report("C_evenFromLevel", "H2_midWeighted")
    _shared_depth_report("H_pyramid", "H2_midWeighted")

    # ── pyramid-specific: edge (deepest rung) fill impact ───────────────────
    for pyramid_label in ("H_pyramid", "H2_midWeighted"):
        h_trades = per_variant[pyramid_label]
        edge_hits = [t for t in h_trades if t.edge_filled]
        edge_miss = [t for t in h_trades if not t.edge_filled]
        print(f"\n=== EDGE-FILL IMPACT ({pyramid_label}) ===")
        print(f"trades reaching deepest (edge) rung : {len(edge_hits)}/{len(h_trades)}")
        if edge_hits:
            wins = [t for t in edge_hits if t.pnl_usd > 0]
            tot = sum(t.pnl_usd for t in edge_hits)
            print(f"  edge-filled  : wins {len(wins)}/{len(edge_hits)}  "
                  f"totalPnL {tot:+.2f}  avg {(tot/len(edge_hits)):+.2f}")
        if edge_miss:
            wins = [t for t in edge_miss if t.pnl_usd > 0]
            tot = sum(t.pnl_usd for t in edge_miss)
            print(f"  edge-missed  : wins {len(wins)}/{len(edge_miss)}  "
                  f"totalPnL {tot:+.2f}  avg {(tot/len(edge_miss)):+.2f}")

    # ── portfolio concurrent-drawdown ───────────────────────────────────────
    print(f"\n=== PORTFOLIO CONCURRENT DRAWDOWN (cross-margin pool stress) ===")
    print(f"{'variant':<20} {'worstOpenOnlyDD':>18}  {'worstEquityDD':>16}")
    for label, *_ in VARIANTS:
        oo, eq_dd = _portfolio_concurrent_dd(per_variant[label])
        print(f"{label:<20} {oo:>+18.2f}  {eq_dd:>+16.2f}")
    print("  (open-only = worst simultaneous unrealized across symbols; "
          "equityDD = peak-to-trough of portfolio total equity)")


if __name__ == "__main__":
    main()
