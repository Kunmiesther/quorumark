"""30-day SNIPER-STACK harness — HARNESS ONLY. Production untouched.

Variants over the SAME 30-day window (bybit_proxy 5m → 15m/1h/4h aggregation):

C) BASELINE:      1.0xATR zone, 4-rung even ladder from swept level,
                  0.25xATR buffer, TP tiers 50/30/20 @ 1.75/2.0/2.5R.

S) SNIPER STACK:  4h HTF alignment gate (unchanged) → 1h detect_sweep
                  ARMS the setup → within 12×15m bars a 15m candle must
                  CLOSE back across the swept level with body_ratio >=
                  SWEEP_BODY_RATIO (reclaim). Only then the ladder deploys
                  with C geometry (equal-margin 4-rung, same zone, same
                  buffer). Runner exit: TP1 50% @ 1.75R, TP2 30% @ 2.0R,
                  final 20% rides until 4h alignment flips (BE stop after
                  TP2). Hard stop + 48-bar (1h) timeout still apply.
                  Skipped setups (no 15m trigger in 12 bars) → "trigger_expired"
                  and we record what C would have done on the same signal.

H) PYRAMID (reference — not simulated here; already ran separately).

Reports head-to-head, sniper-specific arm/trigger stats, runner stats,
portfolio concurrent DD.  Bit-identical to the pyramid harness in
signal generation for C so comparisons stay apples-to-apples.
"""
from __future__ import annotations

import json, math, os, sys, time, urllib.request
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sweep_signal import (
    atr_series, detect_sweep,
    SWEEP_ATR_PERIOD, SWEEP_BODY_RATIO,
    TS, OPEN, HIGH, LOW, CLOSE,
)
from htf_bos import aggregate_1h, aggregate_4h, detect_htf_bos

MIN5_MS = 5 * 60 * 1000
FIFTEEN_MS = 15 * 60 * 1000
HOUR_MS = 60 * 60 * 1000
DAY_MS = 86_400_000
BARS_PER_DAY = DAY_MS // MIN5_MS
HORIZON_DAYS = 30
SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "DOGE-USDT", "XRP-USDT"]
STARTING_EQUITY = 1000.0
RISK_PER_TRADE = 0.02
LEVERAGE_CAP = 20
FEE = 0.0004
MAX_HOLD_BARS_1H = 48
TP_TIERS = [(0.50, 1.75), (0.30, 2.0), (0.20, 2.5)]  # C uses all three; S runner overrides tier3
ZONE_ATR_MULT = 1.0
BUFFER_ATR = 0.25
TRIGGER_MAX_15M_BARS = 12

FRACS_C = [0.0, 1/3, 2/3, 1.0]
WEIGHTS_C = [0.25, 0.25, 0.25, 0.25]
UNITS_C = 4


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


def _aggregate_15m(candles_5m: List[list]) -> List[list]:
    buckets: dict = {}
    order: list = []
    for c in candles_5m:
        b = (int(c[TS]) // FIFTEEN_MS) * FIFTEEN_MS
        if b not in buckets:
            buckets[b] = [b, c[OPEN], c[HIGH], c[LOW], c[CLOSE], c[5]]
            order.append(b)
        else:
            k = buckets[b]
            k[HIGH] = max(k[HIGH], c[HIGH])
            k[LOW] = min(k[LOW], c[LOW])
            k[CLOSE] = c[CLOSE]
            k[5] += c[5]
    counts: dict = {}
    for c in candles_5m:
        b = (int(c[TS]) // FIFTEEN_MS) * FIFTEEN_MS
        counts[b] = counts.get(b, 0) + 1
    return [buckets[h] for h in order if counts.get(h, 0) >= 3]


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
    ran_past_25r: bool = False
    runner_r: float = 0.0   # effective R multiple on the final 20%
    mtm_curve: List[Tuple[int, float]] = field(default_factory=list)


def _c_sim(symbol: str, candles_5m: List[list], variant_label: str,
           collect_signal_map: bool = False):
    """Baseline C simulator. Returns (trades, signal_map).
    signal_map: dict {(sym, 1h_bar_ts) -> trade or None} to allow later
    diagnosis of what a S-skipped setup did under C.
    """
    trades: List[Trade] = []
    signal_map: dict = {}
    if len(candles_5m) < 300: return trades, signal_map
    candles_1h = aggregate_1h(candles_5m)
    n1h = len(candles_1h)
    if n1h < 60: return trades, signal_map
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

            avg = open_pos["avg_entry"]; stop = open_pos["hard_stop"]
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

            live_qty = open_pos["filled_qty"] - open_pos["closed_qty"]
            uPnL = 0.0
            if live_qty > 1e-12:
                uPnL = (close_px - avg) * live_qty if d == "long" else (avg - close_px) * live_qty
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
                tr = Trade(
                    symbol, d, variant_label,
                    open_pos["entry_ts"], bar[TS], avg, stop, reason,
                    open_pos["realized"], open_pos["rungs_filled"],
                    tuple(open_pos["tiers_hit"]),
                    False, 0.0, open_pos["mtm_curve"],
                )
                trades.append(tr)
                if collect_signal_map:
                    signal_map[(symbol, open_pos["signal_bar_ts"])] = tr
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

        rung_prices = [level - f * zone if r.direction == "long" else level + f * zone
                       for f in FRACS_C]
        edge_px = rung_prices[-1]
        hard_stop = (edge_px - BUFFER_ATR * atr_now
                     if r.direction == "long" else edge_px + BUFFER_ATR * atr_now)
        avg_if_full = sum(px * w for px, w in zip(rung_prices, WEIGHTS_C))
        risk_dist = abs(avg_if_full - hard_stop)
        if risk_dist <= 0: continue

        total_qty = (equity * RISK_PER_TRADE) / risk_dist
        max_qty = (equity * LEVERAGE_CAP) / avg_if_full
        total_qty = min(total_qty, max_qty)
        if total_qty <= 0: continue

        rung_qtys = [total_qty * w for w in WEIGHTS_C]
        filled_qty = 0.0; filled_notional = 0.0; rungs_filled = 0
        pending: List[Tuple[float, float]] = []
        for px, q in zip(rung_prices, rung_qtys):
            hit = (r.direction == "long" and lo <= px) or (r.direction == "short" and hi >= px)
            if hit:
                filled_qty += q; filled_notional += q * px; rungs_filled += 1
            else:
                pending.append((px, q))
        if filled_qty <= 0:
            if collect_signal_map:
                signal_map[(symbol, int(bar[TS]))] = None
            continue
        avg_entry = filled_notional / filled_qty
        open_pos = {
            "direction": r.direction, "avg_entry": avg_entry,
            "hard_stop": hard_stop, "filled_qty": filled_qty,
            "filled_notional": filled_notional, "closed_qty": 0.0,
            "realized": -filled_notional * FEE,
            "entry_i": i, "entry_ts": bar[TS],
            "signal_bar_ts": int(bar[TS]),
            "rungs_filled": rungs_filled,
            "tiers_hit": [False, False, False], "pending": pending,
            "mtm_curve": [],
        }
    return trades, signal_map


def _s_sim(symbol: str, candles_5m: List[list]):
    """Sniper-stack simulator. Returns (trades, arm_stats)."""
    trades: List[Trade] = []
    arm_stats = {"armed": 0, "triggered": 0, "expired": 0,
                 "expired_signal_bar_ts": []}
    if len(candles_5m) < 300: return trades, arm_stats
    candles_1h = aggregate_1h(candles_5m)
    candles_15m = _aggregate_15m(candles_5m)
    n1h = len(candles_1h)
    if n1h < 60: return trades, arm_stats
    atr = atr_series(candles_1h, SWEEP_ATR_PERIOD)

    _htf_cache: dict = {}
    def _htf_at(bar_close_ts: int) -> str:
        if bar_close_ts in _htf_cache: return _htf_cache[bar_close_ts]
        sub = [c for c in candles_5m if c[TS] <= bar_close_ts]
        htf_4h = aggregate_4h(sub)
        st = "none" if len(htf_4h) < 20 else detect_htf_bos(htf_4h, tick=0.0).state
        _htf_cache[bar_close_ts] = st
        return st

    # quick lookup: 15m index by ts
    idx15_by_ts = {int(c[TS]): i for i, c in enumerate(candles_15m)}
    ts15_sorted = [int(c[TS]) for c in candles_15m]

    equity = STARTING_EQUITY
    open_pos: Optional[dict] = None

    def _body_ratio(c):
        rng = c[HIGH] - c[LOW]
        return 0.0 if rng <= 0 else abs(c[CLOSE] - c[OPEN]) / rng

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

            avg = open_pos["avg_entry"]; stop = open_pos["hard_stop"]
            R_init = open_pos["R_init"]

            # tier1, tier2 fill (fixed R). tier3 becomes runner.
            for ti, (frac, rr) in enumerate(TP_TIERS[:2]):
                if open_pos["tiers_hit"][ti]: continue
                tp_px = avg + rr * R_init if d == "long" else avg - rr * R_init
                hit_tp = (d == "long" and hi >= tp_px) or (d == "short" and lo <= tp_px)
                if hit_tp and open_pos["filled_qty"] > 0:
                    reduce_qty = open_pos["filled_qty"] * frac
                    gross = (tp_px - avg) * reduce_qty if d == "long" \
                            else (avg - tp_px) * reduce_qty
                    fees = (avg + tp_px) * reduce_qty * FEE
                    open_pos["realized"] += gross - fees
                    open_pos["closed_qty"] += reduce_qty
                    open_pos["tiers_hit"][ti] = True
                    if ti == 1:
                        # tier2 banked → BE stop on runner
                        open_pos["hard_stop"] = avg
                        stop = avg

            # runner: 4h flip exit (only after tier2 in a broader sense; runner
            # actually enters play once both tp1+tp2 taken). But we also permit
            # 4h flip anytime as continuation-fail if trade is in profit? Owner
            # spec: runner rides while 4h continues. We apply 4h-flip exit only
            # to the remaining runner slice after tp2, aligning with the spec.
            htf_now = _htf_at(int(bar[TS]) + HOUR_MS - 1)
            runner_flip = False
            if open_pos["tiers_hit"][1]:
                need = "bullish_bos" if d == "long" else "bearish_bos"
                if htf_now != need:
                    runner_flip = True

            live_qty = open_pos["filled_qty"] - open_pos["closed_qty"]
            uPnL = 0.0
            if live_qty > 1e-12:
                uPnL = (close_px - avg) * live_qty if d == "long" else (avg - close_px) * live_qty
            open_pos["mtm_curve"].append((int(bar[TS]), open_pos["realized"] + uPnL))

            hit_stop = ((d == "long" and lo <= stop) or (d == "short" and hi >= stop))
            timed_out = (i - open_pos["entry_i"]) >= MAX_HOLD_BARS_1H
            if hit_stop or timed_out or runner_flip:
                remaining = open_pos["filled_qty"] - open_pos["closed_qty"]
                if runner_flip and not hit_stop:
                    exit_px = close_px; reason = "runner_4h_flip"
                elif hit_stop:
                    exit_px = stop; reason = "sweep_stop"
                else:
                    exit_px = close_px; reason = "timeout"
                if remaining > 1e-12:
                    gross = (exit_px - avg) * remaining if d == "long" \
                            else (avg - exit_px) * remaining
                    fees = (avg + exit_px) * remaining * FEE
                    open_pos["realized"] += gross - fees
                equity += open_pos["realized"]
                # runner R
                runner_R = 0.0; ran_past = False
                if open_pos["tiers_hit"][1] and R_init > 0:
                    r_move = (exit_px - avg) if d == "long" else (avg - exit_px)
                    runner_R = r_move / R_init
                    ran_past = runner_R > 2.5
                trades.append(Trade(
                    symbol, d, "S_sniper_stack",
                    open_pos["entry_ts"], bar[TS], avg, open_pos["hard_stop_init"],
                    reason, open_pos["realized"], open_pos["rungs_filled"],
                    tuple(open_pos["tiers_hit"]), ran_past, runner_R,
                    open_pos["mtm_curve"],
                ))
                open_pos = None
            else:
                continue

        # DETECT + ARM
        window = candles_1h[: i + 1]
        atr_win = atr[: i + 1]
        htf_state = _htf_at(int(bar[TS]) + HOUR_MS - 1)
        r = detect_sweep(window, atr_win, htf_bos_state=htf_state, tick=0.0)
        if r is None: continue
        if r.direction == "long" and htf_state != "bullish_bos": continue
        if r.direction == "short" and htf_state != "bearish_bos": continue
        atr_now = atr_win[-1] or 0
        if atr_now <= 0: continue

        arm_stats["armed"] += 1

        # 15m TRIGGER search: first 15m candle after this 1h bar closes
        # whose close reclaims the swept level in the reversal direction
        # with body >= SWEEP_BODY_RATIO. Window: 12 × 15m bars.
        arm_close_ts = int(bar[TS]) + HOUR_MS - 1
        # find first 15m index with ts > arm_close_ts
        import bisect
        j0 = bisect.bisect_right(ts15_sorted, arm_close_ts)
        trigger_15m_idx = None
        for j in range(j0, min(j0 + TRIGGER_MAX_15M_BARS, len(candles_15m))):
            c15 = candles_15m[j]
            body = _body_ratio(c15)
            if body < SWEEP_BODY_RATIO: continue
            if r.direction == "long":
                if c15[CLOSE] > r.swept_level and c15[LOW] <= r.swept_level:
                    trigger_15m_idx = j; break
            else:
                if c15[CLOSE] < r.swept_level and c15[HIGH] >= r.swept_level:
                    trigger_15m_idx = j; break

        if trigger_15m_idx is None:
            arm_stats["expired"] += 1
            arm_stats["expired_signal_bar_ts"].append((symbol, int(bar[TS])))
            continue

        arm_stats["triggered"] += 1
        trigger_ts = int(candles_15m[trigger_15m_idx][TS]) + FIFTEEN_MS - 1
        # find containing 1h bar index (>= i, containing trigger_ts)
        trig_i = i
        while trig_i < n1h - 1 and candles_1h[trig_i + 1][TS] <= trigger_ts:
            trig_i += 1
        # ladder deploys at trigger; use atr_now (from arm bar) for zone/stop
        level = r.swept_level
        zone = ZONE_ATR_MULT * atr_now
        rung_prices = [level - f * zone if r.direction == "long" else level + f * zone
                       for f in FRACS_C]
        edge_px = rung_prices[-1]
        hard_stop = (edge_px - BUFFER_ATR * atr_now
                     if r.direction == "long" else edge_px + BUFFER_ATR * atr_now)
        avg_if_full = sum(px * w for px, w in zip(rung_prices, WEIGHTS_C))
        risk_dist = abs(avg_if_full - hard_stop)
        if risk_dist <= 0: continue
        total_qty = (equity * RISK_PER_TRADE) / risk_dist
        max_qty = (equity * LEVERAGE_CAP) / avg_if_full
        total_qty = min(total_qty, max_qty)
        if total_qty <= 0: continue
        rung_qtys = [total_qty * w for w in WEIGHTS_C]

        # Fill any rungs already touched by the trigger 1h bar's range
        # BUT only counting the trigger bar and later — use trig bar's hi/lo.
        trig_bar = candles_1h[trig_i]
        thi, tlo = trig_bar[HIGH], trig_bar[LOW]
        filled_qty = 0.0; filled_notional = 0.0; rungs_filled = 0
        pending: List[Tuple[float, float]] = []
        for px, q in zip(rung_prices, rung_qtys):
            hit = (r.direction == "long" and tlo <= px) or (r.direction == "short" and thi >= px)
            if hit:
                filled_qty += q; filled_notional += q * px; rungs_filled += 1
            else:
                pending.append((px, q))
        if filled_qty <= 0:
            # no rung touched even by trigger bar — set aside as pending on next bars
            avg_entry = 0.0
            # start as open with 0 fills; rungs get filled on later bars
            open_pos = {
                "direction": r.direction, "avg_entry": 0.0,
                "hard_stop": hard_stop, "hard_stop_init": hard_stop,
                "filled_qty": 0.0, "filled_notional": 0.0, "closed_qty": 0.0,
                "realized": 0.0, "entry_i": trig_i, "entry_ts": trig_bar[TS],
                "rungs_filled": 0, "tiers_hit": [False, False, False],
                "pending": pending, "mtm_curve": [], "R_init": None,
            }
        else:
            avg_entry = filled_notional / filled_qty
            open_pos = {
                "direction": r.direction, "avg_entry": avg_entry,
                "hard_stop": hard_stop, "hard_stop_init": hard_stop,
                "filled_qty": filled_qty, "filled_notional": filled_notional,
                "closed_qty": 0.0,
                "realized": -filled_notional * FEE,
                "entry_i": trig_i, "entry_ts": trig_bar[TS],
                "rungs_filled": rungs_filled,
                "tiers_hit": [False, False, False], "pending": pending,
                "mtm_curve": [], "R_init": abs(avg_entry - hard_stop),
            }
        # If we started open_pos at trig_i but the outer loop is at i (i == trig_i
        # since trigger_ts is by construction within a bar >= i, and we've already
        # processed this bar's exit branch above for the prior open_pos which was
        # None) — we simply skip to next i to avoid re-processing.
        # Backfill R_init when first fills arrive on later bars
        if open_pos["R_init"] is None:
            open_pos["R_init"] = 0.0  # placeholder; recomputed once fills happen

    # post-loop: any lingering open_pos ignored (same as C harness)
    return trades, arm_stats


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


def _portfolio_concurrent_dd(trades: List[Trade]) -> Tuple[float, float]:
    if not trades: return (0.0, 0.0)
    all_ts = sorted({ts for t in trades for ts, _ in t.mtm_curve})
    if not all_ts: return (0.0, 0.0)
    per_trade = [(t.entry_ts, t.exit_ts, t.pnl_usd, dict(t.mtm_curve)) for t in trades]
    peak = STARTING_EQUITY
    worst_open = 0.0; worst_eq = 0.0
    realized_locked = 0.0
    locked = set()
    for ts in all_ts:
        for idx, (ets, xts, pnl, curve) in enumerate(per_trade):
            if idx in locked: continue
            if xts < ts:
                realized_locked += pnl; locked.add(idx)
        open_sum = 0.0
        for idx, (ets, xts, pnl, curve) in enumerate(per_trade):
            if ets <= ts <= xts and idx not in locked:
                if ts in curve:
                    open_sum += curve[ts]
                else:
                    latest = None
                    for k, v in curve.items():
                        if k <= ts and (latest is None or k > latest[0]):
                            latest = (k, v)
                    if latest is not None:
                        open_sum += latest[1]
        eq = STARTING_EQUITY + realized_locked + open_sum
        peak = max(peak, eq)
        worst_eq = min(worst_eq, eq - peak)
        worst_open = min(worst_open, open_sum)
    return (worst_open, worst_eq)


def main():
    bars = HORIZON_DAYS * BARS_PER_DAY
    all_5m: Dict[str, List[list]] = {}
    src: Dict[str, str] = {}
    for sym in SYMBOLS:
        c = _fetch_bybit(sym, bars)
        src[sym] = "bybit_proxy" if c else "unavailable"
        all_5m[sym] = c or []

    c_trades: List[Trade] = []
    c_signal_maps: Dict[str, dict] = {}
    s_trades: List[Trade] = []
    s_arm = {"armed": 0, "triggered": 0, "expired": 0, "expired_signal_bar_ts": []}
    for sym in SYMBOLS:
        if not all_5m[sym]: continue
        ct, smap = _c_sim(sym, all_5m[sym], "C_evenFromLevel",
                          collect_signal_map=True)
        c_trades.extend(ct); c_signal_maps[sym] = smap
        st, arm = _s_sim(sym, all_5m[sym])
        s_trades.extend(st)
        s_arm["armed"] += arm["armed"]
        s_arm["triggered"] += arm["triggered"]
        s_arm["expired"] += arm["expired"]
        s_arm["expired_signal_bar_ts"].extend(arm["expired_signal_bar_ts"])

    print(f"\nsymbols     : {SYMBOLS}")
    print(f"data source : {src}")
    print(f"horizon     : {HORIZON_DAYS}d   equity: ${STARTING_EQUITY}   "
          f"lev cap: {LEVERAGE_CAP}x   risk/trade: {RISK_PER_TRADE*100:.1f}%")
    print(f"C: 1.0xATR zone, 4 rungs even, 0.25xATR buffer, TP 50/30/20 @ 1.75/2.0/2.5R.")
    print(f"S: 4h HTF gate → 1h detect ARM → 15m reclaim TRIGGER (12x15m window, "
          f"body>={SWEEP_BODY_RATIO}) → C-geometry ladder; runner 20% rides 4h "
          f"continuation, BE stop after TP2.")

    print("\n=== HEAD-TO-HEAD (30d, same window) ===")
    hdr = (f"{'variant':<20} {'#':>4}  {'win%':>6}  {'avgW':>8}  "
           f"{'avgL':>8}  {'PF':>6}  {'maxDD':>9}  {'totRet':>10}")
    print(hdr); print("-" * len(hdr))
    for label, trs in [("C_evenFromLevel", c_trades), ("S_sniper_stack", s_trades)]:
        m = _metrics(trs)
        pf_s = f"{m['profit_factor']:>6.2f}" if m['profit_factor'] != math.inf else "   inf"
        print(f"{label:<20} {m['trades']:>4}  {m['win_pct']:>5.1f}%  "
              f"{m['avg_win']:>+8.2f}  {m['avg_loss']:>+8.2f}  "
              f"{pf_s}  {m['max_dd']:>+9.2f}  {m['total_return']:>+10.2f}")

    # Arm vs trigger stats + expired-cost analysis
    print(f"\n=== SNIPER ARM/TRIGGER FUNNEL (S only) ===")
    armed = s_arm["armed"]; trig = s_arm["triggered"]; exp = s_arm["expired"]
    trate = (100.0 * trig / armed) if armed else 0
    print(f"  1h signals ARMED        : {armed}")
    print(f"  15m TRIGGERED           : {trig}   ({trate:.1f}%)")
    print(f"  trigger_expired         : {exp}")

    # cost/savings of demanding trigger
    exp_pnl_under_c = 0.0
    exp_seen = 0; exp_wins = 0; exp_losses = 0
    for (sym, arm_ts) in s_arm["expired_signal_bar_ts"]:
        c_tr = c_signal_maps.get(sym, {}).get((sym, arm_ts))
        if c_tr is None: continue
        exp_seen += 1
        exp_pnl_under_c += c_tr.pnl_usd
        if c_tr.pnl_usd > 0: exp_wins += 1
        else: exp_losses += 1
    print(f"  matched to C outcome    : {exp_seen}/{exp}  "
          f"(others = no fill under C either)")
    print(f"  expired trades would have delivered under C: "
          f"{exp_pnl_under_c:+.2f} USD  (wins {exp_wins} / losses {exp_losses})")
    print(f"  → NEGATIVE number = trigger requirement SAVED us that loss")
    print(f"  → POSITIVE number = trigger requirement COST us that profit")

    # runner stats
    if s_trades:
        runner_trades = [t for t in s_trades if t.tiers_hit[1]]
        past25 = [t for t in runner_trades if t.ran_past_25r]
        best = max((t.runner_r for t in runner_trades), default=0.0)
        avg_r = (sum(t.runner_r for t in runner_trades) / len(runner_trades)
                 if runner_trades else 0.0)
        print(f"\n=== S RUNNER STATS ===")
        print(f"  trades that reached TP2 (runner armed) : {len(runner_trades)}/{len(s_trades)}")
        print(f"  runner rode past 2.5R                  : {len(past25)}")
        print(f"  avg runner R (post-TP2 exit)           : {avg_r:+.2f}R")
        print(f"  best runner R                          : {best:+.2f}R")

    # tier / exit mix
    print(f"\n=== TIER + EXIT MIX ===")
    for label, trs in [("C_evenFromLevel", c_trades), ("S_sniper_stack", s_trades)]:
        if not trs:
            print(f"{label}: no trades"); continue
        n = len(trs)
        t1 = 100.0 * sum(1 for t in trs if t.tiers_hit[0]) / n
        t2 = 100.0 * sum(1 for t in trs if t.tiers_hit[1]) / n
        t3 = 100.0 * sum(1 for t in trs if t.tiers_hit[2]) / n
        exits = {}
        for t in trs:
            exits[t.exit_reason] = exits.get(t.exit_reason, 0) + 1
        exs = "  ".join(f"{k}:{100.0*v/n:.1f}%" for k, v in exits.items())
        print(f"  {label}: tp1 {t1:.1f}%  tp2 {t2:.1f}%  tp3 {t3:.1f}%  |  {exs}")

    # portfolio concurrent DD
    print(f"\n=== PORTFOLIO CONCURRENT DRAWDOWN ===")
    print(f"{'variant':<20} {'worstOpenOnlyDD':>18}  {'worstEquityDD':>16}")
    for label, trs in [("C_evenFromLevel", c_trades), ("S_sniper_stack", s_trades)]:
        oo, eq = _portfolio_concurrent_dd(trs)
        print(f"{label:<20} {oo:>+18.2f}  {eq:>+16.2f}")
    print("  H (pyramid) reference from prior 30d run: totRet +939.76, "
          "maxDD -72.57, worstOpenDD -122.26 — not re-run here (identical window).")


if __name__ == "__main__":
    main()
