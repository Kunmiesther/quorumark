"""Clean two-bot structural strategy — LIMIT-TP-AT-PIVOT fix.

Two independent bots ($600 each), single entry, structural exits.

Fixes vs backtest_pnl_structural.py:
  1) TP is a LIMIT at the favorable pivot LEVEL. Filled ONLY when a candle's
     high (long) / low (short) actually TOUCHES the level. Fill at pivot
     price minus slippage. No touch = no fill.
  2) FLAT margin fraction: margin = 10% of $600 wallet = $60 regardless of
     leverage. Notional = margin * leverage. 25x = $1,500, 50x = $3,000,
     100x = $6,000. Leverage now actually varies exposure.

Stop: unchanged. Confirmed candle CLOSE beyond setup opposite pivot.
Exit priority when both hit in same candle: STOP first (worst case).
Floor $500 as last resort.

Costs: taker 5bps + slip 2bps per fill. Funding NOT modeled.
Strategy files untouched.
"""
from __future__ import annotations

import traceback
from dataclasses import dataclass
from typing import Optional

import accumulator_signal as sig
import market_data as md

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

WALLET_BASE = 600.0
FLOOR = 500.0
MARGIN_FRACTION = 0.10        # flat 10% of wallet
TAKER_BPS = 5.0
SLIP_BPS = 2.0
FEE_RATE = TAKER_BPS / 10_000.0
SLIP_RATE = SLIP_BPS / 10_000.0


@dataclass
class Trade:
    direction: str
    entry_i: int
    entry_ts: float
    entry_px: float
    fill_px: float
    qty: float
    notional: float
    margin: float
    tp_level: float       # limit price
    stop_level: float
    exit_i: Optional[int] = None
    exit_ts: Optional[float] = None
    exit_px: Optional[float] = None
    outcome: str = "open"   # "tp" | "stop" | "floor" | "open"
    pnl: float = 0.0
    fees: float = 0.0
    slip_cost: float = 0.0
    worst_upnl: float = 0.0


def apply_slip(px: float, side: str, is_entry: bool) -> float:
    if is_entry:
        return px * (1 + SLIP_RATE) if side == "long" else px * (1 - SLIP_RATE)
    return px * (1 - SLIP_RATE) if side == "long" else px * (1 + SLIP_RATE)


def upnl(t: Trade, px: float) -> float:
    if t.direction == "long":
        return (px - t.fill_px) * t.qty
    return (t.fill_px - px) * t.qty


def close_trade(t: Trade, exit_i: int, exit_ts: float, raw_exit_px: float, outcome: str):
    exit_px = apply_slip(raw_exit_px, t.direction, is_entry=False)
    t.exit_i = exit_i
    t.exit_ts = exit_ts
    t.exit_px = exit_px
    t.outcome = outcome
    exit_fee = exit_px * t.qty * FEE_RATE
    t.fees += exit_fee
    t.slip_cost += abs(exit_px - raw_exit_px) * t.qty
    gross = upnl(t, exit_px)
    t.pnl = gross - exit_fee   # entry fee applied at open


def open_trade(direction, i, ts, raw_px, leverage, tp_level, stop_level) -> Trade:
    fill = apply_slip(raw_px, direction, is_entry=True)
    margin = MARGIN_FRACTION * WALLET_BASE
    notional = margin * leverage
    qty = notional / fill
    entry_fee = fill * qty * FEE_RATE
    t = Trade(
        direction=direction, entry_i=i, entry_ts=ts, entry_px=raw_px,
        fill_px=fill, qty=qty, notional=notional, margin=margin,
        tp_level=tp_level, stop_level=stop_level,
        fees=entry_fee, slip_cost=abs(fill - raw_px) * qty,
    )
    t.pnl = -entry_fee
    return t


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
        out.append({
            "entry_i": entry_i,
            "entry_ts": float(candles[entry_i][TS]),
            "entry_px": entry_px,
            "stop_level": stop_level,
            "direction": direction,
        })
    return out, swings


def next_favorable_pivot(swings, direction, entry_i, entry_px):
    """First confirmed favorable pivot AFTER entry, level beyond entry.
    Returns (level, pivot_index, confirm_index) or None. We use pivot_index
    as the earliest time the pivot LEVEL is known to exist on-chart (we still
    require price to TOUCH the level at any candle >= entry+1 to fill)."""
    fav_kind = "high" if direction == "long" else "low"
    cand = [s for s in swings if s.kind == fav_kind and s.pivot_index > entry_i]
    for s in sorted(cand, key=lambda x: x.pivot_index):
        if direction == "long" and s.level > entry_px:
            return s.level, s.pivot_index, s.confirm_index
        if direction == "short" and s.level < entry_px:
            return s.level, s.pivot_index, s.confirm_index
    return None


def simulate_bot(candles, direction, leverage, tick):
    setups, swings = build_setup_signals(candles, direction, tick)
    trades: list[Trade] = []
    open_t: Optional[Trade] = None
    floor_hits = 0
    liquidations = 0
    tp_limits_placed = 0
    tp_limits_filled = 0
    running_realized = 0.0
    peak_real = 0.0
    max_dd = 0.0

    by_i: dict[int, list] = {}
    for s in setups:
        by_i.setdefault(s["entry_i"], []).append(s)

    for j in range(len(candles)):
        c = candles[j]
        hi, lo, cl = float(c[HIGH]), float(c[LOW]), float(c[CLOSE])
        ts = float(c[TS])

        if open_t is not None:
            # Track worst upnl for stats + floor check
            worst_px = lo if open_t.direction == "long" else hi
            u = upnl(open_t, worst_px)
            if u < open_t.worst_upnl:
                open_t.worst_upnl = u

            # Exit priority per spec: STOP first if both could trigger this bar.
            stop_hit = (
                (open_t.direction == "long" and cl < open_t.stop_level) or
                (open_t.direction == "short" and cl > open_t.stop_level)
            )
            # Limit TP: filled only if this candle's high/low actually touches
            tp_hit = False
            if open_t.tp_level is not None:
                if open_t.direction == "long" and hi >= open_t.tp_level:
                    tp_hit = True
                if open_t.direction == "short" and lo <= open_t.tp_level:
                    tp_hit = True

            # Floor check on unrealized
            equity_now = WALLET_BASE + u
            floor_trip = equity_now <= FLOOR
            liq = equity_now <= 0

            if liq:
                liquidations += 1
                close_trade(open_t, j, ts, worst_px, "floor")
                trades.append(open_t); open_t = None
            elif stop_hit:
                close_trade(open_t, j, ts, cl, "stop")
                trades.append(open_t); open_t = None
            elif tp_hit:
                tp_limits_filled += 1
                # Fill at pivot price (limit), then slip is applied in close_trade.
                close_trade(open_t, j, ts, open_t.tp_level, "tp")
                trades.append(open_t); open_t = None
            elif floor_trip:
                floor_hits += 1
                close_trade(open_t, j, ts, worst_px, "floor")
                trades.append(open_t); open_t = None

        # Book realized + DD tracking on each close
        while trades and getattr(trades[-1], "_booked", False) is False:
            trades[-1]._booked = True
            if trades[-1].outcome != "open":
                running_realized += trades[-1].pnl
                peak_real = max(peak_real, running_realized)
                dd = peak_real - running_realized
                if dd > max_dd:
                    max_dd = dd

        # Entry
        if open_t is None and j in by_i:
            for s in by_i[j]:
                fav = next_favorable_pivot(swings, direction, j, s["entry_px"])
                if fav is None:
                    continue
                tp_level, tp_pivot_i, tp_confirm_i = fav
                t = open_trade(direction, j, ts, cl, leverage, tp_level, s["stop_level"])
                open_t = t
                tp_limits_placed += 1
                break

    if open_t is not None:
        open_t.outcome = "open"
        trades.append(open_t)

    return {
        "trades": trades,
        "realized": running_realized, "max_dd": max_dd,
        "floor_hits": floor_hits, "liquidations": liquidations,
        "tp_placed": tp_limits_placed, "tp_filled": tp_limits_filled,
    }


def summarize(res, label):
    trades = res["trades"]
    wins = [t for t in trades if t.outcome == "tp"]
    losses_stop = [t for t in trades if t.outcome == "stop"]
    losses_floor = [t for t in trades if t.outcome == "floor"]
    losses = losses_stop + losses_floor
    openn = [t for t in trades if t.outcome == "open"]
    n_closed = len(trades) - len(openn)
    net = sum(t.pnl for t in trades if t.outcome != "open")
    fees = sum(t.fees for t in trades)
    slip = sum(t.slip_cost for t in trades)
    gross = net + fees
    avg_win = (sum(t.pnl for t in wins) / len(wins)) if wins else 0.0
    avg_loss = (sum(t.pnl for t in losses) / len(losses)) if losses else 0.0
    ratio = (avg_win / abs(avg_loss)) if avg_loss < 0 else (float("inf") if wins else 0.0)
    worst = min((t.pnl for t in losses), default=0.0)
    holds = [(t.exit_i - t.entry_i) for t in trades if t.exit_i is not None]
    avg_hold = (sum(holds) / len(holds)) if holds else 0.0

    def dist_pct(t, kind):
        ref = t.tp_level if kind == "tp" else t.stop_level
        return abs(ref - t.fill_px) / t.fill_px * 100

    avg_tp_dist = (sum(dist_pct(t, "tp") for t in wins) / len(wins)) if wins else 0.0
    avg_stop_dist = (sum(dist_pct(t, "stop") for t in losses_stop) / len(losses_stop)) if losses_stop else 0.0

    return {
        "label": label, "n": len(trades), "n_closed": n_closed,
        "wins": len(wins), "stops": len(losses_stop),
        "floors": len(losses_floor), "open": len(openn),
        "win_rate": (len(wins) / n_closed * 100) if n_closed else 0.0,
        "net": net, "gross": gross, "fees": fees, "slip": slip,
        "avg_win": avg_win, "avg_loss": avg_loss, "ratio": ratio,
        "worst": worst, "avg_hold": avg_hold,
        "avg_tp_dist_pct": avg_tp_dist, "avg_stop_dist_pct": avg_stop_dist,
        "max_dd": res["max_dd"], "realized": res["realized"],
        "floor_hits": res["floor_hits"], "liquidations": res["liquidations"],
        "tp_placed": res["tp_placed"], "tp_filled": res["tp_filled"],
    }


def print_bot(s):
    print(f"\n  --- {s['label']} ---")
    print(f"    trades={s['n']} (closed={s['n_closed']}) wins={s['wins']} stops={s['stops']} floors={s['floors']} open={s['open']}")
    print(f"    win rate (closed): {s['win_rate']:.1f}%")
    print(f"    TP limits: placed={s['tp_placed']}  filled={s['tp_filled']}  unfilled={s['tp_placed']-s['tp_filled']-s['open']}  (honesty check)")
    print(f"    avg win: ${s['avg_win']:+.2f}   avg loss: ${s['avg_loss']:+.2f}   WIN/LOSS RATIO: {s['ratio']:.3f}")
    print(f"    gross ${s['gross']:+.2f}  fees ${s['fees']:.2f}  slip ${s['slip']:.2f}  NET ${s['net']:+.2f}")
    print(f"    worst single loss: ${s['worst']:+.2f}   max DD: ${s['max_dd']:.2f}")
    print(f"    floor_hits={s['floor_hits']}  liquidations={s['liquidations']}")
    print(f"    avg hold (5m candles): {s['avg_hold']:.1f}   avg TP dist realized: {s['avg_tp_dist_pct']:.2f}%   avg stop dist: {s['avg_stop_dist_pct']:.2f}%")


def main():
    sym = "BTC-USDT"
    hours = 720
    print("=" * 100)
    print("LIMIT-TP-AT-PIVOT · FLAT MARGIN · two bots · sweep 25x/50x/100x")
    print("BTC-USDT · 30 days · 5m ApeX klines · $600/bot · $500 floor · $60 flat margin")
    print("TP: LIMIT at pivot level (fills only on touch)   STOP: confirmed close beyond setup opp pivot")
    print("Priority when both trigger same bar: STOP wins (worst case).")
    print("Costs: taker 5bps + slip 2bps per fill.  Funding: NOT modeled.")
    print("=" * 100)

    feed = md.ApexPublicFeed()
    try:
        print(f"\nFetching {hours}h of 5m {sym} klines ...")
        f = feed.fetch_range(sym, 5, hours=hours)
        print(f"Got {len(f.candles)} candles  tick={f.tick}")
    except Exception as e:
        print("\n!!! DATA FETCH FAILED — ApeX egress likely blocked here.")
        print(f"    {type(e).__name__}: {e}")
        traceback.print_exc()
        print("\nApeX egress blocked — must run on Railway.")
        return

    all_s = {}
    for lev in (25, 50, 100):
        margin = MARGIN_FRACTION * WALLET_BASE
        notional = margin * lev
        print("\n" + "=" * 100)
        print(f"LEVERAGE {lev}x   |   flat margin=${margin:.0f}   notional=${notional:.0f}")
        print("=" * 100)
        rl = simulate_bot(f.candles, "long", lev, f.tick)
        rs = simulate_bot(f.candles, "short", lev, f.tick)
        sl = summarize(rl, f"BOT LONG  @ {lev}x")
        ss = summarize(rs, f"BOT SHORT @ {lev}x")
        print_bot(sl); print_bot(ss)
        cn = sl["net"] + ss["net"]
        cdd = sl["max_dd"] + ss["max_dd"]
        print(f"\n  --- COMBINED @ {lev}x (on $1,200) ---")
        print(f"    NET: ${cn:+.2f}   combined max DD: ${cdd:.2f}")
        print(f"    total trades: {sl['n']+ss['n']}   total wins: {sl['wins']+ss['wins']}")
        all_s[lev] = (sl, ss, cn, cdd)

    print("\n" + "=" * 100)
    print("SUMMARY TABLE")
    print("=" * 100)
    print(f"  {'lev':>5}  {'notional':>10}  {'LONG net':>10}  {'L ratio':>8}  {'SHORT net':>10}  {'S ratio':>8}  {'COMBINED':>10}  {'DD':>9}")
    for lev, (sl, ss, cn, cdd) in all_s.items():
        nt = MARGIN_FRACTION * WALLET_BASE * lev
        lr = sl["ratio"] if sl["ratio"] != float("inf") else 99.0
        sr = ss["ratio"] if ss["ratio"] != float("inf") else 99.0
        print(f"  {lev:>4}x  ${nt:>9.0f}  ${sl['net']:>+9.2f}  {lr:>8.3f}  ${ss['net']:>+9.2f}  {sr:>8.3f}  ${cn:>+9.2f}  ${cdd:>8.2f}")

    print("\n" + "=" * 100)
    print("PLAIN ASSESSMENT")
    print("=" * 100)
    best_lev = max(all_s.keys(), key=lambda k: all_s[k][2])
    sl_b, ss_b, cn_b, cdd_b = all_s[best_lev]
    # risk-adjusted: NET / max DD
    def ra(sl, ss, cn, cdd):
        return cn / cdd if cdd > 0 else (cn if cn else 0.0)
    best_ra_lev = max(all_s.keys(), key=lambda k: ra(*all_s[k]))
    prev_ratio_note = "prior run (confirm-close TP): ~0.15-0.25"
    print(f"* Best raw NET leverage: {best_lev}x  combined ${cn_b:+.2f}  DD ${cdd_b:.2f}")
    print(f"* Best RISK-ADJUSTED (NET/DD): {best_ra_lev}x  ratio {ra(*all_s[best_ra_lev]):.3f}")
    print(f"* Payoff ratios at best-net lev: LONG {sl_b['ratio']:.3f}  SHORT {ss_b['ratio']:.3f}   ({prev_ratio_note})")
    verdict = "PROFITABLE" if cn_b > 0 else "NET-NEGATIVE"
    print(f"* Verdict at {best_lev}x: {verdict}")


if __name__ == "__main__":
    main()
