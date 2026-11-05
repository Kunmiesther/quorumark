"""HTF (1h) BOS promotion — Phase 2 backtest harness.

Models three variants of the clean two-bot structural strategy, adding a
1h-BOS-driven runner promotion on top of the LIMIT-TP-AT-PIVOT baseline
(mirrors backtest_pnl_limit_tp.py conventions):

  A  baseline           : fixed limit-TP at favorable pivot (unchanged).
  B  pure runner        : on confirmed 1h BOS in trade direction while in
                          profit → cancel TP, stop to breakeven+fees,
                          exit on adverse 1h BOS (or hard stop).
  C  50/50 hybrid       : bank 50% at original fixed TP, remainder becomes
                          runner per (B).
  C2 rung-based split   : bank 60% at original fixed TP (proxy for the
                          engine's rung-1 skim), remainder becomes runner.

Promotion in B/C/C2 REQUIRES ALL of:
  - position is open,
  - unrealized PnL > 0,
  - confirmed 1h BOS in the position direction.
Losing positions are NEVER promoted.

1h BOS: 12x 5m candles aggregated to the hour boundary (drop the
still-forming hour). Uses accumulator_signal.evaluate() on the 1h series to
mirror the EXACT 5m rules the engine uses.
"""
from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from typing import Optional

import accumulator_signal as sig
import market_data as md

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

WALLET_BASE = 600.0
FLOOR = 500.0
MARGIN_FRACTION = 0.10
TAKER_BPS = 5.0
SLIP_BPS = 2.0
FEE_RATE = TAKER_BPS / 10_000.0
SLIP_RATE = SLIP_BPS / 10_000.0
HOUR_MS = 60 * 60 * 1000
CANDLES_PER_HOUR = 12


# ─── 1h aggregation ──────────────────────────────────────────────────────
def aggregate_1h(candles):
    """5m → 1h buckets. Drops the still-forming trailing hour and any
    bucket with fewer than 12 constituent 5m candles."""
    if not candles:
        return []
    buckets = {}
    for c in candles:
        start = (int(c[TS]) // HOUR_MS) * HOUR_MS
        buckets.setdefault(start, []).append(c)
    newest = candles[-1]
    forming = (int(newest[TS]) // HOUR_MS) * HOUR_MS
    buckets.pop(forming, None)
    out = []
    for start in sorted(buckets):
        group = sorted(buckets[start], key=lambda c: c[TS])
        if len(group) < CANDLES_PER_HOUR:
            continue
        hi = max(c[HIGH] for c in group)
        lo = min(c[LOW] for c in group)
        vol = sum(c[VOLUME] for c in group)
        out.append([start, group[0][OPEN], hi, lo, group[-1][CLOSE], vol])
    return out


def htf_break_events(htf_1h, tick):
    """Chronologically sorted (ts, direction, level) confirmed 1h break
    events across both directions — same rules as the 5m engine path."""
    if len(htf_1h) < 20:
        return []
    rl = sig.evaluate(htf_1h, "long", tick)
    rs = sig.evaluate(htf_1h, "short", tick)
    evs = []
    for be in rl["breaks"]:
        evs.append((float(be.break_ts), "long", float(be.swing.level)))
    for be in rs["breaks"]:
        evs.append((float(be.break_ts), "short", float(be.swing.level)))
    evs.sort(key=lambda x: x[0])
    return evs


# ─── shared trade plumbing ───────────────────────────────────────────────
@dataclass
class Trade:
    direction: str
    entry_i: int
    entry_ts: float
    fill_px: float
    qty: float
    notional: float
    margin: float
    tp_level: float
    stop_level: float
    exit_i: Optional[int] = None
    exit_ts: Optional[float] = None
    exit_px: Optional[float] = None
    outcome: str = "open"
    pnl: float = 0.0
    fees: float = 0.0
    slip_cost: float = 0.0
    promoted: bool = False
    partial_skim_pnl: float = 0.0
    peak_upnl: float = 0.0
    give_back: float = 0.0
    _booked: bool = False


def apply_slip(px, side, is_entry):
    if is_entry:
        return px * (1 + SLIP_RATE) if side == "long" else px * (1 - SLIP_RATE)
    return px * (1 - SLIP_RATE) if side == "long" else px * (1 + SLIP_RATE)


def upnl(t, px, qty=None):
    q = t.qty if qty is None else qty
    if t.direction == "long":
        return (px - t.fill_px) * q
    return (t.fill_px - px) * q


def open_trade(direction, i, ts, raw_px, leverage, tp_level, stop_level):
    fill = apply_slip(raw_px, direction, is_entry=True)
    margin = MARGIN_FRACTION * WALLET_BASE
    notional = margin * leverage
    qty = notional / fill
    entry_fee = fill * qty * FEE_RATE
    t = Trade(direction=direction, entry_i=i, entry_ts=ts, fill_px=fill,
              qty=qty, notional=notional, margin=margin,
              tp_level=tp_level, stop_level=stop_level,
              fees=entry_fee, slip_cost=abs(fill - raw_px) * qty)
    t.pnl = -entry_fee
    return t


def close_trade(t, exit_i, exit_ts, raw_exit_px, outcome, qty=None):
    q = t.qty if qty is None else qty
    exit_px = apply_slip(raw_exit_px, t.direction, is_entry=False)
    exit_fee = exit_px * q * FEE_RATE
    gross = upnl(t, exit_px, q)
    t.fees += exit_fee
    t.slip_cost += abs(exit_px - raw_exit_px) * q
    pnl_slice = gross - exit_fee
    if qty is None or abs(q - t.qty) < 1e-12:
        t.exit_i = exit_i
        t.exit_ts = exit_ts
        t.exit_px = exit_px
        t.outcome = outcome
        t.pnl += pnl_slice
    else:
        t.partial_skim_pnl += pnl_slice
        t.qty -= q
    return pnl_slice


def build_setup_signals(candles, direction, tick):
    atr = sig.wilder_atr_series(candles)
    raw = sig.find_confirmed_swings(candles)
    swings = sig.group_liquidity_zones(raw, atr, tick)
    result = sig.evaluate(candles, direction, tick)
    entries = [r for r in result["entries"] if r.state == "confirmed"]
    out = []
    for r in entries:
        entry_i = r.retest_index
        entry_px = float(candles[entry_i][CLOSE])
        opp_kind = "low" if direction == "long" else "high"
        opp = [s for s in swings if s.kind == opp_kind and s.confirm_index <= entry_i]
        if not opp:
            continue
        stop_swing = max(opp, key=lambda s: s.pivot_index)
        stop_level = stop_swing.level
        if direction == "long" and stop_level >= entry_px:
            continue
        if direction == "short" and stop_level <= entry_px:
            continue
        out.append({"entry_i": entry_i, "entry_ts": float(candles[entry_i][TS]),
                    "entry_px": entry_px, "stop_level": stop_level,
                    "direction": direction})
    return out, swings


def next_favorable_pivot(swings, direction, entry_i, entry_px):
    fav_kind = "high" if direction == "long" else "low"
    for s in sorted([s for s in swings if s.kind == fav_kind and s.pivot_index > entry_i],
                    key=lambda x: x.pivot_index):
        if direction == "long" and s.level > entry_px:
            return s.level
        if direction == "short" and s.level < entry_px:
            return s.level
    return None


# ─── variant simulator ───────────────────────────────────────────────────
def simulate(candles, direction, leverage, tick, variant, htf_events):
    """variant ∈ {'A','B','C','C2'}."""
    setups, swings = build_setup_signals(candles, direction, tick)
    trades: list[Trade] = []
    open_t: Optional[Trade] = None
    promotions = 0
    by_i: dict[int, list] = {}
    for s in setups:
        by_i.setdefault(s["entry_i"], []).append(s)

    def htf_state_at(ts):
        """Latest confirmed HTF break at or before ts → 'long'|'short'|None."""
        latest = None
        for ets, edir, _lvl in htf_events:
            if ets <= ts:
                latest = edir
            else:
                break
        return latest

    def promote(t, j, ts, cl):
        """Convert to runner: cancel TP, stop → breakeven+fees, mark promoted."""
        t.promoted = True
        # breakeven target = fill_px adjusted for fees round-trip.
        fee_offset = t.fill_px * FEE_RATE * 2
        t.stop_level = (t.fill_px + fee_offset) if t.direction == "long" \
            else (t.fill_px - fee_offset)
        t.tp_level = float("inf") if t.direction == "long" else -float("inf")

    for j in range(len(candles)):
        c = candles[j]
        hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])
        ts = float(c[TS])

        if open_t is not None:
            worst_px = lo if open_t.direction == "long" else hi
            best_px = hi if open_t.direction == "long" else lo
            u_worst = upnl(open_t, worst_px)
            u_best = upnl(open_t, best_px)
            if u_best > open_t.peak_upnl:
                open_t.peak_upnl = u_best

            # ── Runner promotion (B/C/C2) ────────────────────────────────
            if variant in ("B", "C", "C2") and not open_t.promoted:
                cur_u = upnl(open_t, cl)
                htf = htf_state_at(ts)
                aligned = (htf == open_t.direction)
                if aligned and cur_u > 0:
                    # C/C2: bank partial at original TP THEN promote.
                    if variant in ("C", "C2"):
                        skim_frac = 0.5 if variant == "C" else 0.6
                        skim_qty = open_t.qty * skim_frac
                        # Only skim if the TP is favorable & achievable right
                        # now (we skim at current close as a synthetic partial
                        # fill on the promotion bar).
                        close_trade(open_t, j, ts, cl, "partial_skim", qty=skim_qty)
                    promote(open_t, j, ts, cl)
                    promotions += 1

            # ── Adverse HTF BOS exit (only runners) ──────────────────────
            adverse_htf = False
            if open_t.promoted and variant in ("B", "C", "C2"):
                htf = htf_state_at(ts)
                if htf is not None and htf != open_t.direction:
                    adverse_htf = True

            stop_hit = (
                (open_t.direction == "long" and cl < open_t.stop_level) or
                (open_t.direction == "short" and cl > open_t.stop_level)
            )
            tp_hit = False
            if not open_t.promoted:
                if open_t.direction == "long" and hi >= open_t.tp_level:
                    tp_hit = True
                if open_t.direction == "short" and lo <= open_t.tp_level:
                    tp_hit = True

            equity_now = WALLET_BASE + u_worst
            floor_trip = equity_now <= FLOOR
            liq = equity_now <= 0

            if liq:
                close_trade(open_t, j, ts, worst_px, "floor")
                open_t.give_back = open_t.peak_upnl - upnl(open_t, worst_px) if open_t.promoted else 0.0
                trades.append(open_t); open_t = None
            elif stop_hit:
                close_trade(open_t, j, ts, cl, "stop_be" if open_t.promoted else "stop")
                if open_t.promoted:
                    open_t.give_back = open_t.peak_upnl - upnl(open_t, cl)
                trades.append(open_t); open_t = None
            elif adverse_htf:
                close_trade(open_t, j, ts, cl, "htf_exit")
                open_t.give_back = open_t.peak_upnl - upnl(open_t, cl)
                trades.append(open_t); open_t = None
            elif tp_hit:
                close_trade(open_t, j, ts, open_t.tp_level, "tp")
                trades.append(open_t); open_t = None
            elif floor_trip:
                close_trade(open_t, j, ts, worst_px, "floor")
                trades.append(open_t); open_t = None

        if open_t is None and j in by_i:
            for s in by_i[j]:
                fav = next_favorable_pivot(swings, direction, j, s["entry_px"])
                if fav is None:
                    continue
                open_t = open_trade(direction, j, ts, cl, leverage, fav, s["stop_level"])
                break

    if open_t is not None:
        trades.append(open_t)
    return trades, promotions


def summarize(trades, promotions, label):
    closed = [t for t in trades if t.outcome != "open"]
    wins = [t for t in closed if (t.pnl + t.partial_skim_pnl) > 0]
    losses = [t for t in closed if (t.pnl + t.partial_skim_pnl) <= 0]
    net = sum(t.pnl + t.partial_skim_pnl for t in closed)
    # max drawdown on running realized curve
    running = 0.0; peak = 0.0; dd = 0.0
    for t in closed:
        running += t.pnl + t.partial_skim_pnl
        peak = max(peak, running)
        if peak - running > dd:
            dd = peak - running
    avg_win = sum(t.pnl + t.partial_skim_pnl for t in wins) / len(wins) if wins else 0.0
    avg_loss = sum(t.pnl + t.partial_skim_pnl for t in losses) / len(losses) if losses else 0.0
    runners = [t for t in trades if t.promoted]
    avg_give = sum(t.give_back for t in runners) / len(runners) if runners else 0.0
    return {
        "label": label, "n": len(trades), "closed": len(closed),
        "wins": len(wins), "losses": len(losses),
        "win_rate": (len(wins) / len(closed) * 100) if closed else 0.0,
        "net": net, "max_dd": dd,
        "avg_win": avg_win, "avg_loss": avg_loss,
        "promotions": promotions, "avg_give_back": avg_give,
    }


def print_row(s):
    print(f"  {s['label']:>28}  net ${s['net']:>+9.2f}  DD ${s['max_dd']:>7.2f}  "
          f"WR {s['win_rate']:>5.1f}%  W {s['wins']:>3}  L {s['losses']:>3}  "
          f"avgW ${s['avg_win']:>+7.2f}  avgL ${s['avg_loss']:>+7.2f}  "
          f"promos {s['promotions']:>3}  giveback ${s['avg_give_back']:>+7.2f}")


def main():
    sym = "BTC-USDT"
    hours = 720
    leverage = 100
    print("=" * 110)
    print("HTF (1h) BOS PROMOTION · Phase 2 backtest · BTC-USDT · 30d · 5m klines · 100x · $600/bot")
    print("Variants: A baseline | B pure runner | C 50/50 hybrid | C2 60/40 (rung-proxy) hybrid")
    print("Promotion requires: open + unrealized>0 + confirmed 1h BOS aligned to direction.")
    print("=" * 110)

    feed = md.ApexPublicFeed()
    try:
        f = feed.fetch_range(sym, 5, hours=hours)
        print(f"Fetched {len(f.candles)} 5m candles  tick={f.tick}")
    except Exception as e:
        print("!!! DATA FETCH FAILED — ApeX egress likely blocked here.")
        print(f"    {type(e).__name__}: {e}")
        traceback.print_exc()
        print("\nApeX egress blocked — run on Railway.")
        return

    htf_1h = aggregate_1h(f.candles)
    htf_events = htf_break_events(htf_1h, f.tick)
    print(f"1h candles: {len(htf_1h)}   confirmed 1h break events: {len(htf_events)}")

    all_rows = []
    for variant in ("A", "B", "C", "C2"):
        print("\n" + "-" * 110)
        print(f"VARIANT {variant}")
        print("-" * 110)
        for direction in ("long", "short"):
            trades, promos = simulate(f.candles, direction, leverage, f.tick, variant, htf_events)
            s = summarize(trades, promos, f"{variant} · BOT {direction.upper()} @ {leverage}x")
            print_row(s)
            all_rows.append((variant, direction, s))

    print("\n" + "=" * 110)
    print("COMPARISON TABLE (combined LONG+SHORT per variant)")
    print("=" * 110)
    print(f"  {'variant':>7}  {'combined net':>14}  {'combined DD':>13}  "
          f"{'trades':>7}  {'wins':>5}  {'promos':>7}  {'avg give-back':>15}")
    for variant in ("A", "B", "C", "C2"):
        rows = [s for v, _d, s in all_rows if v == variant]
        cnet = sum(r["net"] for r in rows)
        cdd = sum(r["max_dd"] for r in rows)
        cn = sum(r["n"] for r in rows)
        cw = sum(r["wins"] for r in rows)
        cp = sum(r["promotions"] for r in rows)
        cg = sum(r["avg_give_back"] for r in rows) / len(rows) if rows else 0.0
        print(f"  {variant:>7}  ${cnet:>+13.2f}  ${cdd:>12.2f}  "
              f"{cn:>7}  {cw:>5}  {cp:>7}  ${cg:>+14.2f}")


if __name__ == "__main__":
    main()
