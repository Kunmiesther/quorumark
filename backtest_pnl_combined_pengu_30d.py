"""COMBINED backtest — PENGU-USDT, 30 days, Accumulator + Hunter, both directions.

Tests the "team" thesis: does running complementary strategies together beat
either alone in return AND risk-adjusted terms?

Four wallets ($600 each, $500 floor, 25x baseline, flat $60 margin):
  1. Accumulator-LONG  — validated break-and-retest, limit-TP at favorable pivot, BOS stop
  2. Accumulator-SHORT — same, mirrored
  3. Hunter-LONG       — FVG + ATR gate K=1.3, fill/reversal variant (recommended)
  4. Hunter-SHORT      — same, mirrored

Reports Accumulator-pair alone, Hunter-pair alone, ALL-FOUR combined, with:
  net, win rate, combined max DD, net/DD ratio, overlap %, per-wallet contribution.

Real ApeX 5m data. Costs: taker 5bps + slip 2bps per fill. Funding NOT modeled.
Does NOT touch paper engine / worker / strategy modules.
"""
from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, List

import accumulator_signal as sig
import hunter_signal as hs
import market_data as md

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

SYMBOL = "PENGU-USDT"
DAYS = 30
HOURS = DAYS * 24
WALLET_BASE = 600.0
FLOOR = 500.0
MARGIN = 60.0
LEVERAGE_BASE = 25
LEVERAGE_ALT = 50           # PENGU venue max, secondary line
TAKER_BPS = 5.0
SLIP_BPS = 2.0
FEE_RATE = TAKER_BPS / 10_000.0
SLIP_RATE = SLIP_BPS / 10_000.0
HUNTER_K = 1.3
HUNTER_VARIANT = "fill"     # validated recommended
MIN_HOLD_FOR_ATR_EXIT = 3


@dataclass
class Trade:
    wallet: str
    strategy: str        # "acc" | "hunt"
    direction: str
    entry_i: int
    entry_ts: int
    entry_px: float      # slipped fill price
    qty: float
    notional: float
    tp_level: Optional[float]
    stop_level: float
    exit_i: Optional[int] = None
    exit_ts: Optional[int] = None
    exit_px: Optional[float] = None
    outcome: str = "open"
    pnl: float = 0.0
    fees: float = 0.0
    slip_cost: float = 0.0


def slip(px, side, is_entry):
    if is_entry:
        return px * (1 + SLIP_RATE) if side == "long" else px * (1 - SLIP_RATE)
    return px * (1 - SLIP_RATE) if side == "long" else px * (1 + SLIP_RATE)


def upnl(t: Trade, px: float) -> float:
    if t.direction == "long":
        return (px - t.entry_px) * t.qty
    return (t.entry_px - px) * t.qty


def open_trade(wallet, strategy, direction, i, ts, raw_px, leverage, tp_level, stop_level) -> Trade:
    fill = slip(raw_px, direction, True)
    notional = MARGIN * leverage
    qty = notional / fill
    entry_fee = fill * qty * FEE_RATE
    return Trade(
        wallet=wallet, strategy=strategy, direction=direction,
        entry_i=i, entry_ts=int(ts), entry_px=fill,
        qty=qty, notional=notional,
        tp_level=tp_level, stop_level=stop_level,
        fees=entry_fee, slip_cost=abs(fill - raw_px) * qty, pnl=-entry_fee,
    )


def close_trade(t: Trade, exit_i, ts, raw_exit_px, outcome):
    exit_px = slip(raw_exit_px, t.direction, False)
    exit_fee = exit_px * t.qty * FEE_RATE
    t.fees += exit_fee
    t.slip_cost += abs(exit_px - raw_exit_px) * t.qty
    gross = upnl(t, exit_px)
    t.pnl = gross - t.fees  # net of entry+exit fees
    t.exit_i, t.exit_ts, t.exit_px, t.outcome = exit_i, int(ts), exit_px, outcome


# ---------- Accumulator setups ----------
def build_acc_setups(candles, direction, tick):
    atr = sig.wilder_atr_series(candles)
    raw = sig.find_confirmed_swings(candles)
    swings = sig.group_liquidity_zones(raw, atr, tick)
    result = sig.evaluate(candles, direction, tick)
    entries = [r for r in result["entries"] if r.state == "confirmed"]
    out = []
    for r in entries:
        ei = r.retest_index
        epx = float(candles[ei][CLOSE])
        opp_kind = "low" if direction == "long" else "high"
        opp = [s for s in swings if s.kind == opp_kind and s.confirm_index <= ei]
        if not opp:
            continue
        stop_swing = max(opp, key=lambda s: s.pivot_index)
        stop_level = stop_swing.level
        if direction == "long" and stop_level >= epx: continue
        if direction == "short" and stop_level <= epx: continue
        out.append({"entry_i": ei, "entry_ts": float(candles[ei][TS]),
                    "entry_px": epx, "stop_level": stop_level})
    return out, swings


def next_fav_pivot(swings, direction, entry_i, entry_px):
    fav = "high" if direction == "long" else "low"
    for s in sorted([x for x in swings if x.kind == fav and x.pivot_index > entry_i],
                    key=lambda x: x.pivot_index):
        if direction == "long" and s.level > entry_px: return s.level
        if direction == "short" and s.level < entry_px: return s.level
    return None


# ---------- Hunter setups (fill variant) ----------
def build_hunter_setups(candles, direction, k):
    fvgs = hs.find_fvgs(candles, k)
    swings = hs.find_swings(candles)
    want = "bullish" if direction == "long" else "bearish"
    out = []
    for fvg in fvgs:
        if fvg.direction != want: continue
        confirm = fvg.confirm_index
        # look for retrace into gap within 24 candles
        entry_i = None; entry_px = None
        for j in range(confirm + 1, min(confirm + 25, len(candles))):
            c = candles[j]; lo = float(c[LOW]); hi = float(c[HIGH])
            if direction == "long" and lo <= fvg.gap_upper:
                entry_i = j; entry_px = min(fvg.gap_upper, float(c[OPEN])); break
            if direction == "short" and hi >= fvg.gap_lower:
                entry_i = j; entry_px = max(fvg.gap_lower, float(c[OPEN])); break
        if entry_i is None: continue
        stop_level = fvg.gap_lower if direction == "long" else fvg.gap_upper
        out.append({"entry_i": entry_i, "entry_ts": float(candles[entry_i][TS]),
                    "entry_px": entry_px, "stop_level": stop_level})
    return out, swings


def next_hunter_tp(swings, direction, entry_i, entry_px):
    for s in swings:
        if s.index <= entry_i: continue
        if direction == "long" and s.kind == "high" and s.level > entry_px: return s.level
        if direction == "short" and s.kind == "low" and s.level < entry_px: return s.level
    return None


# ---------- Unified simulator per wallet ----------
def simulate_wallet(candles, wallet_name, strategy, direction, setups, swings,
                    leverage, atr=None, atr_sma=None) -> List[Trade]:
    trades: List[Trade] = []
    open_t: Optional[Trade] = None
    realized = 0.0
    floor_hit = False
    by_i: dict[int, list] = {}
    for s in setups:
        by_i.setdefault(s["entry_i"], []).append(s)

    for j in range(len(candles)):
        if floor_hit: break
        c = candles[j]
        hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])
        ts = float(c[TS])

        if open_t is not None:
            stop_hit = ((open_t.direction == "long" and cl < open_t.stop_level) or
                        (open_t.direction == "short" and cl > open_t.stop_level))
            tp_hit = False
            if open_t.tp_level is not None:
                if open_t.direction == "long" and hi >= open_t.tp_level: tp_hit = True
                if open_t.direction == "short" and lo <= open_t.tp_level: tp_hit = True
            worst_px = lo if open_t.direction == "long" else hi
            equity_now = WALLET_BASE + realized + upnl(open_t, worst_px)
            floor_trip = equity_now <= FLOOR

            atr_weak = False
            if strategy == "hunt" and atr is not None and atr_sma is not None:
                if j - open_t.entry_i >= MIN_HOLD_FOR_ATR_EXIT:
                    a = atr[j]; s_ = atr_sma[j]
                    if a is not None and s_ is not None and s_ > 0 and (a / s_) < 1.0:
                        atr_weak = True

            if stop_hit:
                close_trade(open_t, j, ts, cl, "stop")
            elif tp_hit:
                close_trade(open_t, j, ts, open_t.tp_level, "tp")
            elif atr_weak:
                close_trade(open_t, j, ts, cl, "atr_weak")
            elif floor_trip:
                close_trade(open_t, j, ts, worst_px, "floor")
                floor_hit = True
            if open_t.outcome != "open":
                realized += open_t.pnl
                trades.append(open_t); open_t = None

        if open_t is None and not floor_hit and j in by_i:
            for s in by_i[j]:
                if strategy == "acc":
                    tp = next_fav_pivot(swings, direction, j, s["entry_px"])
                    if tp is None: continue
                else:
                    tp = next_hunter_tp(swings, direction, j, s["entry_px"])
                    # continue even if tp is None (structural exit or atr)
                open_t = open_trade(wallet_name, strategy, direction, j, ts, cl,
                                    leverage, tp, s["stop_level"])
                break

    if open_t is not None:
        trades.append(open_t)
    return trades


# ---------- Analytics ----------
def equity_curve(trades: List[Trade], start_equity: float):
    """Chronological equity curve from realized closes."""
    closed = sorted([t for t in trades if t.outcome != "open"], key=lambda x: x.exit_ts or 0)
    curve = [(0, start_equity)]
    eq = start_equity
    for t in closed:
        eq += t.pnl
        curve.append((t.exit_ts, eq))
    return curve


def max_dd(curve):
    peak = curve[0][1]; mdd = 0.0
    for _, eq in curve:
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    return mdd


def summarize(label, trade_groups, start_equity_total):
    """trade_groups: list of trade lists (each list = one wallet's trades)."""
    all_trades = [t for g in trade_groups for t in g]
    closed = [t for t in all_trades if t.outcome != "open"]
    wins = [t for t in closed if t.pnl > 0]
    losses = [t for t in closed if t.pnl <= 0]
    net = sum(t.pnl for t in closed)
    wr = (len(wins) / len(closed) * 100) if closed else 0.0
    # Combined equity curve: merge all wallet closes chronologically
    ordered = sorted(closed, key=lambda x: x.exit_ts or 0)
    eq = start_equity_total; peak = eq; mdd = 0.0
    curve_points = [eq]
    for t in ordered:
        eq += t.pnl
        peak = max(peak, eq); mdd = max(mdd, peak - eq)
        curve_points.append(eq)
    best = max((t.pnl for t in closed), default=0.0)
    worst = min((t.pnl for t in closed), default=0.0)
    ret_pct = (net / start_equity_total * 100) if start_equity_total else 0.0
    dd_pct = (mdd / start_equity_total * 100) if start_equity_total else 0.0
    ratio = (net / mdd) if mdd > 0 else float("inf") if net > 0 else 0.0
    return {
        "label": label, "trades": len(closed), "win_rate": wr, "net": net,
        "ret_pct": ret_pct, "max_dd": mdd, "dd_pct": dd_pct,
        "net_dd_ratio": ratio, "best": best, "worst": worst,
        "wins": len(wins), "losses": len(losses),
    }


def print_row(s):
    print(f"  {s['label']:32s} trades={s['trades']:4d}  wr={s['win_rate']:5.1f}%  "
          f"NET=${s['net']:+9.2f} ({s['ret_pct']:+6.1f}%)  "
          f"maxDD=${s['max_dd']:7.2f} ({s['dd_pct']:5.1f}%)  "
          f"net/DD={s['net_dd_ratio']:6.2f}")


def overlap_pct(group_a, group_b):
    """% of time (in candle-steps) either strategy was in a position AND the other was too."""
    def spans(g):
        return [(t.entry_i, t.exit_i if t.exit_i is not None else t.entry_i)
                for t in g if t.outcome != "open" or True]
    a_spans = [(t.entry_i, t.exit_i if t.exit_i else t.entry_i) for g in group_a for t in g]
    b_spans = [(t.entry_i, t.exit_i if t.exit_i else t.entry_i) for g in group_b for t in g]
    if not a_spans or not b_spans: return 0.0
    a_set = set()
    for s, e in a_spans:
        for i in range(s, e + 1): a_set.add(i)
    b_set = set()
    for s, e in b_spans:
        for i in range(s, e + 1): b_set.add(i)
    inter = len(a_set & b_set)
    union = len(a_set | b_set)
    return (inter / union * 100) if union else 0.0


def run(leverage: int, candles, tick):
    print(f"\n{'='*78}\nLEVERAGE = {leverage}x\n{'='*78}")

    # Accumulator setups
    acc_long_setups, acc_swings_l = build_acc_setups(candles, "long", tick)
    acc_short_setups, acc_swings_s = build_acc_setups(candles, "short", tick)
    print(f"Accumulator setups: long={len(acc_long_setups)} short={len(acc_short_setups)}")

    # Hunter setups + ATR series
    atr = hs.wilder_atr(candles)
    atr_sma = hs.sma_of(atr, hs.ATR_SMA_PERIOD)
    vs = hs.volatility_stats(candles, HUNTER_K)
    hunt_long_setups, hunt_swings_l = build_hunter_setups(candles, "long", HUNTER_K)
    hunt_short_setups, hunt_swings_s = build_hunter_setups(candles, "short", HUNTER_K)
    print(f"Hunter FVG setups (K={HUNTER_K}, variant={HUNTER_VARIANT}, "
          f"hot={vs['hot_fraction']*100:.1f}%): long={len(hunt_long_setups)} short={len(hunt_short_setups)}")

    # Simulate 4 wallets
    acc_long  = simulate_wallet(candles, "acc-long",  "acc", "long",  acc_long_setups, acc_swings_l, leverage)
    acc_short = simulate_wallet(candles, "acc-short", "acc", "short", acc_short_setups, acc_swings_s, leverage)
    hunt_long = simulate_wallet(candles, "hunt-long", "hunt", "long",  hunt_long_setups, hunt_swings_l, leverage, atr, atr_sma)
    hunt_short= simulate_wallet(candles, "hunt-short","hunt", "short", hunt_short_setups, hunt_swings_s, leverage, atr, atr_sma)

    per_wallet = [("acc-long", acc_long), ("acc-short", acc_short),
                  ("hunt-long", hunt_long), ("hunt-short", hunt_short)]

    # Per-wallet nets
    print("\nPer-wallet:")
    for name, trs in per_wallet:
        closed = [t for t in trs if t.outcome != "open"]
        wins = len([t for t in closed if t.pnl > 0])
        net = sum(t.pnl for t in closed)
        curve = equity_curve(trs, WALLET_BASE)
        mdd = max_dd(curve)
        wr = (wins/len(closed)*100) if closed else 0.0
        floor = any(t.outcome == "floor" for t in trs)
        print(f"  {name:12s} trades={len(closed):4d}  wr={wr:5.1f}%  "
              f"NET=${net:+8.2f}  maxDD=${mdd:7.2f}  {'FLOOR-HIT' if floor else ''}")

    # Comparisons
    print("\nTHREE-WAY COMPARISON:")
    acc_pair = summarize("Accumulator-pair (L+S)", [acc_long, acc_short], WALLET_BASE * 2)
    hunt_pair = summarize("Hunter-pair (L+S)",     [hunt_long, hunt_short], WALLET_BASE * 2)
    combined = summarize("ALL 4 COMBINED",         [acc_long, acc_short, hunt_long, hunt_short], WALLET_BASE * 4)
    print_row(acc_pair); print_row(hunt_pair); print_row(combined)

    # Overlap
    ov = overlap_pct([acc_long, acc_short], [hunt_long, hunt_short])
    print(f"\nAccumulator ↔ Hunter time-in-market overlap: {ov:.1f}%  "
          f"(lower = more regime-complementary)")

    # Verdict
    print("\nVERDICT NUMBERS:")
    best_component = max(acc_pair["net"], hunt_pair["net"])
    best_ratio = max(acc_pair["net_dd_ratio"], hunt_pair["net_dd_ratio"])
    beats_return = combined["net"] > best_component
    smoother = combined["dd_pct"] < min(acc_pair["dd_pct"], hunt_pair["dd_pct"])
    better_ratio = combined["net_dd_ratio"] > best_ratio
    print(f"  combined NET > best single pair?      {beats_return}  "
          f"(${combined['net']:+.2f} vs ${best_component:+.2f})")
    print(f"  combined DD% < both pairs alone?      {smoother}  "
          f"({combined['dd_pct']:.1f}% vs acc {acc_pair['dd_pct']:.1f}% / hunt {hunt_pair['dd_pct']:.1f}%)")
    print(f"  combined net/DD > best single ratio?  {better_ratio}  "
          f"({combined['net_dd_ratio']:.2f} vs {best_ratio:.2f})")
    print(f"  best single trade:  ${combined['best']:+.2f}")
    print(f"  worst single trade: ${combined['worst']:+.2f}")
    return {"acc": acc_pair, "hunt": hunt_pair, "combined": combined}


def main():
    print("=" * 78)
    print(f"COMBINED BACKTEST — {SYMBOL}, {DAYS} days, Accumulator + Hunter")
    print(f"  4 wallets × $600 = $2,400 deployed, $500 floor per wallet")
    print(f"  margin=${MARGIN}, leverage baseline={LEVERAGE_BASE}x (alt {LEVERAGE_ALT}x)")
    print(f"  Hunter K={HUNTER_K}, variant={HUNTER_VARIANT}")
    print(f"  costs: taker {TAKER_BPS}bps + slip {SLIP_BPS}bps/side, funding NOT modeled")
    print("=" * 78)

    feed = md.ApexPublicFeed()
    print(f"\nFetching {HOURS}h of 5m klines for {SYMBOL}...")
    try:
        f = feed.fetch_range(SYMBOL, 5, hours=HOURS)
    except Exception as e:
        print(f"BLOCKED — real error:\n{type(e).__name__}: {e}")
        traceback.print_exc(); return 2
    c = f.candles
    if len(c) < 100:
        print(f"insufficient candles: {len(c)}"); return 2
    first_ts = int(c[0][TS]); last_ts = int(c[-1][TS])
    d0 = datetime.fromtimestamp(first_ts/1000, tz=timezone.utc)
    d1 = datetime.fromtimestamp(last_ts/1000, tz=timezone.utc)
    print(f"candles={len(c)} tick={f.tick}  window: {d0.isoformat()} → {d1.isoformat()}  "
          f"({(len(c)*5)/60/24:.1f} days)")

    baseline = run(LEVERAGE_BASE, c, f.tick)
    secondary = run(LEVERAGE_ALT, c, f.tick)

    print("\n" + "=" * 78)
    print("SECONDARY LINE (50x, PENGU venue max) SUMMARY:")
    print_row(secondary["acc"]); print_row(secondary["hunt"]); print_row(secondary["combined"])

    print("\n" + "=" * 78)
    print("HONESTY DISCLAIMER")
    print("=" * 78)
    print("  30 days on ONE memecoin (PENGU) = a single-window sketch, not proof.")
    print("  Fat-tail regimes dominate short windows. One trend leg can flatter or")
    print("  crush the entire result. Treat as directional evidence only. Funding")
    print("  costs are excluded; on perps these bite over 30d, especially on memes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
