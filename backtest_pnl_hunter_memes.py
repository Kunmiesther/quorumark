"""Hunter memecoin sketch — 30d, K=1.1, per-symbol venue max leverage.

Uses hunter_signal.py + market_data.py. Independent of paper engine/worker.
Symbol max leverage read live from ApeX symbols endpoint (1/initialMarginRate).
"""
from __future__ import annotations
import json, urllib.request, traceback
from dataclasses import dataclass
from typing import List, Optional

import hunter_signal as hs
import market_data as md

MARGIN = 60.0
STARTING_EQUITY = 600.0
FLOOR = 500.0
TAKER_BPS = 5.0
SLIP_BPS = 2.0
FEE_RATE = TAKER_BPS / 10_000.0
SLIP_RATE = SLIP_BPS / 10_000.0
MIN_HOLD_FOR_ATR_EXIT = 3
K = 1.1

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

TARGETS = [
    ("ETH",     "ETH-USDT"),
    ("PENGU",   "PENGU-USDT"),
    ("PEPE",    "1000PEPE-USDT"),  # apex lists as 1000PEPE
    ("MOODENG", "MOODENG-USDT"),
    ("CASHCAT", "CASHCAT-USDT"),
]


def fetch_venue_specs():
    r = urllib.request.urlopen("https://omni.apex.exchange/api/v3/symbols", timeout=30)
    b = json.loads(r.read())
    perp = b["data"]["contractConfig"]["perpetualContract"]
    by = {}
    for p in perp:
        s = (p.get("symbol") or "").upper()
        imr = p.get("initialMarginRate")
        try:
            imr = float(imr) if imr is not None else None
        except Exception:
            imr = None
        by[s] = imr
    return by


@dataclass
class Trade:
    direction: str
    variant: str
    entry_i: int
    entry_ts: int
    entry_px: float
    stop_px: float
    tp_px: Optional[float]
    exit_i: int = 0
    exit_ts: int = 0
    exit_px: float = 0.0
    exit_reason: str = "open"
    gross_pnl: float = 0.0
    fees: float = 0.0
    slip: float = 0.0
    net_pnl: float = 0.0


def _next_swing(swings, direction, entry_i, entry_px):
    for s in swings:
        if s.index <= entry_i:
            continue
        if direction == "long" and s.kind == "high" and s.level > entry_px:
            return s
        if direction == "short" and s.kind == "low" and s.level < entry_px:
            return s
    return None


def _finish(t: Trade, notional: float, exit_i, exit_px, ts, reason):
    qty = notional / t.entry_px
    if t.direction == "long":
        t.gross_pnl = (exit_px - t.entry_px) * qty
    else:
        t.gross_pnl = (t.entry_px - exit_px) * qty
    t.fees = notional * FEE_RATE + (qty * exit_px) * FEE_RATE
    t.slip = notional * SLIP_RATE + (qty * exit_px) * SLIP_RATE
    t.net_pnl = t.gross_pnl - t.fees - t.slip
    t.exit_i, t.exit_px, t.exit_ts, t.exit_reason = exit_i, exit_px, ts, reason


def simulate(candles, fvgs, swings, variant, atr, atr_sma, notional):
    trades = []
    cursor = -1
    equity = STARTING_EQUITY
    for fvg in fvgs:
        if equity <= FLOOR:
            break
        confirm = fvg.confirm_index
        if confirm <= cursor:
            continue
        direction = "long" if fvg.direction == "bullish" else "short"
        if variant == "continuation":
            entry_i = confirm + 1
            if entry_i >= len(candles):
                continue
            entry_px = float(candles[entry_i][OPEN])
            stop_px = fvg.gap_lower if direction == "long" else fvg.gap_upper
        else:
            entry_i = None; entry_px = None
            for j in range(confirm + 1, min(confirm + 25, len(candles))):
                c = candles[j]
                lo = float(c[LOW]); hi = float(c[HIGH])
                if direction == "long" and lo <= fvg.gap_upper:
                    entry_i = j; entry_px = min(fvg.gap_upper, float(c[OPEN])); break
                if direction == "short" and hi >= fvg.gap_lower:
                    entry_i = j; entry_px = max(fvg.gap_lower, float(c[OPEN])); break
            if entry_i is None:
                continue
            stop_px = fvg.gap_lower if direction == "long" else fvg.gap_upper

        tp = _next_swing(swings, direction, entry_i, entry_px)
        t = Trade(direction, variant, entry_i, int(candles[entry_i][TS]),
                  entry_px, stop_px, tp.level if tp else None)
        exited = False
        for j in range(entry_i + 1, len(candles)):
            c = candles[j]
            hi = float(c[HIGH]); lo = float(c[LOW]); cl = float(c[CLOSE])
            if direction == "long" and cl < t.stop_px:
                _finish(t, notional, j, cl, int(c[TS]), "bos_stop"); exited=True; cursor=j; break
            if direction == "short" and cl > t.stop_px:
                _finish(t, notional, j, cl, int(c[TS]), "bos_stop"); exited=True; cursor=j; break
            if t.tp_px is not None:
                if direction == "long" and hi >= t.tp_px:
                    _finish(t, notional, j, t.tp_px, int(c[TS]), "swing_tp"); exited=True; cursor=j; break
                if direction == "short" and lo <= t.tp_px:
                    _finish(t, notional, j, t.tp_px, int(c[TS]), "swing_tp"); exited=True; cursor=j; break
            if j - entry_i >= MIN_HOLD_FOR_ATR_EXIT:
                a = atr[j]; s = atr_sma[j]
                if a is not None and s is not None and s > 0 and (a / s) < 1.0:
                    _finish(t, notional, j, cl, int(c[TS]), "atr_weak"); exited=True; cursor=j; break
        if not exited:
            _finish(t, notional, len(candles)-1, float(candles[-1][CLOSE]),
                    int(candles[-1][TS]), "end_of_data")
            cursor = len(candles)
        equity += t.net_pnl
        trades.append(t)
    return trades


def summarize(symbol, variant, lev, trades):
    closed = [t for t in trades if t.exit_reason != "open"]
    wins = [t for t in closed if t.net_pnl > 0]
    losses = [t for t in closed if t.net_pnl <= 0]
    N = len(closed); W = len(wins); L = len(losses)
    wr = (W / N * 100) if N else 0.0
    avgW = (sum(t.net_pnl for t in wins) / W) if W else 0.0
    avgL = (sum(t.net_pnl for t in losses) / L) if L else 0.0
    payoff = (avgW / abs(avgL)) if avgL < 0 else (float("inf") if avgW > 0 else 0.0)
    gross = sum(t.gross_pnl for t in closed)
    fees = sum(t.fees for t in closed)
    slip = sum(t.slip for t in closed)
    net = sum(t.net_pnl for t in closed)
    best = max((t.net_pnl for t in closed), default=0.0)
    worst = min((t.net_pnl for t in closed), default=0.0)
    eq = STARTING_EQUITY; peak = eq; dd = 0.0
    for t in closed:
        eq += t.net_pnl
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    return dict(symbol=symbol, variant=variant, lev=lev, N=N, W=W, L=L, wr=wr,
                avgW=avgW, avgL=avgL, payoff=payoff, gross=gross, fees=fees,
                slip=slip, net=net, dd=dd, best=best, worst=worst)


def main():
    print("=" * 100)
    print(f"HUNTER MEMECOIN SKETCH — 30d, K={K}, per-symbol venue max leverage")
    print(f"  margin=${MARGIN}  start=${STARTING_EQUITY}  floor=${FLOOR}  "
          f"taker={TAKER_BPS}bps  slip={SLIP_BPS}bps")
    print("=" * 100)

    specs = fetch_venue_specs()
    feed = md.ApexPublicFeed()
    hours = 24 * 30
    resolved = []
    unavailable = []

    # Resolve venue leverage
    print("\nSymbol verification (ApeX venue caps):")
    for label, sym in TARGETS:
        imr = specs.get(sym.upper())
        if imr is None:
            print(f"  {label:10s}  {sym:16s}  NOT LISTED on ApeX (no data)")
            unavailable.append(label)
            continue
        lev = int(round(1.0 / imr))
        print(f"  {label:10s}  {sym:16s}  initialMarginRate={imr:.4f}  → maxLev={lev}x")
        resolved.append((label, sym, lev))

    all_rows = []
    for label, sym, lev in resolved:
        print(f"\n===== {label} ({sym})  lev={lev}x =====")
        try:
            f = feed.fetch_range(sym, 5, hours=hours)
        except Exception as e:
            print(f"  fetch FAILED: {type(e).__name__}: {e}")
            traceback.print_exc()
            continue
        c = f.candles
        if not c:
            print("  no candles returned")
            continue
        import datetime as dt
        t0 = dt.datetime.utcfromtimestamp(c[0][TS]/1000).strftime("%Y-%m-%d %H:%M")
        t1 = dt.datetime.utcfromtimestamp(c[-1][TS]/1000).strftime("%Y-%m-%d %H:%M")
        span = (len(c) * 5) / 60 / 24
        print(f"  candles={len(c)}  span={span:.1f}d  {t0} → {t1} UTC  tick={f.tick}")

        atr = hs.wilder_atr(c)
        atr_sma = hs.sma_of(atr, hs.ATR_SMA_PERIOD)
        swings = hs.find_swings(c)
        vstats = hs.volatility_stats(c, K)
        fvgs = hs.find_fvgs(c, K)
        print(f"  gate hot: {vstats['hot_fraction']*100:.1f}%   FVGs={len(fvgs)}")

        notional = MARGIN * lev
        for variant in ("fill", "continuation"):
            trades = simulate(c, fvgs, swings, variant, atr, atr_sma, notional)
            row = summarize(label, variant, lev, trades)
            all_rows.append(row)
            print(f"  {variant:12s} lev={lev:3d}x  N={row['N']:3d}  W={row['W']:3d}  L={row['L']:3d}  "
                  f"wr={row['wr']:5.1f}%  avgW=${row['avgW']:+7.2f}  avgL=${row['avgL']:+7.2f}  "
                  f"payoff={row['payoff']:5.2f}  gross=${row['gross']:+8.2f}  fees=${row['fees']:6.2f}  "
                  f"slip=${row['slip']:6.2f}  NET=${row['net']:+8.2f}  DD=${row['dd']:6.2f}  "
                  f"best=${row['best']:+7.2f}  worst=${row['worst']:+7.2f}")

    print("\n" + "=" * 100)
    print("FULL TABLE")
    print("=" * 100)
    hdr = f"{'symbol':10s} {'var':12s} {'lev':>5s} {'N':>4s} {'W':>4s} {'L':>4s} {'wr%':>6s} " \
          f"{'avgW$':>8s} {'avgL$':>8s} {'payoff':>7s} {'gross$':>9s} {'fees$':>7s} {'slip$':>7s} " \
          f"{'NET$':>9s} {'DD$':>7s} {'best$':>8s} {'worst$':>8s}"
    print(hdr)
    for r in all_rows:
        print(f"{r['symbol']:10s} {r['variant']:12s} {r['lev']:4d}x {r['N']:4d} {r['W']:4d} {r['L']:4d} "
              f"{r['wr']:6.1f} {r['avgW']:+8.2f} {r['avgL']:+8.2f} {r['payoff']:7.2f} "
              f"{r['gross']:+9.2f} {r['fees']:7.2f} {r['slip']:7.2f} {r['net']:+9.2f} "
              f"{r['dd']:7.2f} {r['best']:+8.2f} {r['worst']:+8.2f}")

    fills = [r for r in all_rows if r['variant'] == 'fill']
    conts = [r for r in all_rows if r['variant'] == 'continuation']
    print("\n" + "=" * 100)
    print("AGGREGATES")
    print("=" * 100)
    if fills:
        deployed = STARTING_EQUITY * len(fills)
        net = sum(r['net'] for r in fills)
        dd = sum(r['dd'] for r in fills)  # simple sum (worst case, wallets independent)
        best = max((r['best'] for r in fills), default=0.0)
        worst = min((r['worst'] for r in fills), default=0.0)
        print(f"FILL variant across {len(fills)} symbols: deployed=${deployed:.0f}  "
              f"NET=${net:+.2f}  return={net/deployed*100:+.1f}%  "
              f"combined DD (sum)=${dd:.2f}  best=${best:+.2f}  worst=${worst:+.2f}  "
              f"trades={sum(r['N'] for r in fills)}")
    if conts:
        deployed = STARTING_EQUITY * len(conts)
        net = sum(r['net'] for r in conts)
        dd = sum(r['dd'] for r in conts)
        best = max((r['best'] for r in conts), default=0.0)
        worst = min((r['worst'] for r in conts), default=0.0)
        print(f"CONT variant across {len(conts)} symbols: deployed=${deployed:.0f}  "
              f"NET=${net:+.2f}  return={net/deployed*100:+.1f}%  "
              f"combined DD (sum)=${dd:.2f}  best=${best:+.2f}  worst=${worst:+.2f}  "
              f"trades={sum(r['N'] for r in conts)}")

    if unavailable:
        print(f"\nNOT LISTED on ApeX (skipped, no fabrication): {', '.join(unavailable)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
