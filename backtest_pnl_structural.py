"""Clean single-entry, pivot-to-pivot structural exits.

Two dedicated bots (long-only, short-only), separate $600 wallets, $500 floor.
Sweep leverage: 25x, 50x, 100x. BTC-USDT, 30 days of 5m ApeX klines.

Entry: single confirmed break-and-retest (accumulator_signal.evaluate).
TP:   at the next confirmed swing pivot in the trade's favor (long -> next
      confirmed swing HIGH above entry; short -> next confirmed swing LOW
      below entry). Exit at the CLOSE of that pivot's confirmation candle.
Stop: confirmed candle CLOSE beyond the OPPOSITE pivot that defined the
      setup (long -> most recent confirmed swing LOW at/before entry;
      short -> most recent confirmed swing HIGH). Structural, symmetric.
Floor: last-resort flatten if wallet equity <= $500.

Costs: taker 5 bps + slippage 2 bps on entry and exit (2 fills per trade).
Funding: NOT modeled (label).

Sizing: single position, margin_fraction = 10 / leverage of wallet.
        notional = margin * leverage. One position at a time per bot.

Strategy files (accumulator_signal.py, market_data.py) UNTOUCHED.
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
NOTIONAL_CONST = 10.0        # margin_fraction = 10 / leverage
TAKER_BPS = 5.0
SLIP_BPS = 2.0
FEE_RATE = TAKER_BPS / 10_000.0
SLIP_RATE = SLIP_BPS / 10_000.0


@dataclass
class Trade:
    direction: str
    entry_i: int
    entry_ts: float
    entry_px: float          # ideal
    fill_px: float           # after slippage
    qty: float               # base units
    notional: float
    margin: float
    tp_level: float          # price target (opposite favorable pivot)
    stop_level: float        # setup opposite-pivot level
    exit_i: Optional[int] = None
    exit_ts: Optional[float] = None
    exit_px: Optional[float] = None
    outcome: str = "open"    # "tp" | "stop" | "floor" | "open"
    pnl: float = 0.0
    fees: float = 0.0
    slip_cost: float = 0.0
    worst_upnl: float = 0.0  # min unrealized (most negative)


def apply_slip(px: float, side: str, is_entry: bool) -> float:
    # Long entry / short exit -> pay up; short entry / long exit -> pay down.
    if is_entry:
        return px * (1 + SLIP_RATE) if side == "long" else px * (1 - SLIP_RATE)
    else:
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
    # slippage cost recorded (informational)
    t.slip_cost += abs(exit_px - raw_exit_px) * t.qty
    gross = upnl(t, exit_px)
    t.pnl = gross - exit_fee   # entry fee already deducted at open


def open_trade(direction: str, i: int, ts: float, raw_px: float, wallet: float,
               leverage: float, tp_level: float, stop_level: float) -> Trade:
    fill = apply_slip(raw_px, direction, is_entry=True)
    mf = NOTIONAL_CONST / leverage
    margin = mf * wallet
    notional = margin * leverage
    qty = notional / fill
    entry_fee = fill * qty * FEE_RATE
    t = Trade(
        direction=direction, entry_i=i, entry_ts=ts, entry_px=raw_px,
        fill_px=fill, qty=qty, notional=notional, margin=margin,
        tp_level=tp_level, stop_level=stop_level,
        fees=entry_fee, slip_cost=abs(fill - raw_px) * qty,
    )
    # entry fee reduces starting pnl basis
    t.pnl = -entry_fee
    return t


def build_setup_signals(candles, direction, tick):
    """Return list of (retest_index, retest_ts, entry_close, tp_level, stop_level)
    using only confirmed retests. tp_level = next confirmed favorable pivot after
    entry (long: swing HIGH > entry, exit at pivot's confirm-candle close).
    stop_level = most recent confirmed opposite pivot at/before break candle."""
    atr_at = sig.wilder_atr_series(candles)
    ema_at = sig.ema_series(candles)
    raw = sig.find_confirmed_swings(candles)
    swings = sig.group_liquidity_zones(raw, atr_at, tick)
    result = sig.evaluate(candles, direction, tick)
    entries = [r for r in result["entries"] if r.state == "confirmed"]

    out = []
    for r in entries:
        be = r.break_event
        entry_i = r.retest_index
        entry_px = float(candles[entry_i][CLOSE])
        # stop = most recent confirmed opposite pivot with confirm_index <= entry_i
        opp_kind = "low" if direction == "long" else "high"
        opp = [s for s in swings if s.kind == opp_kind and s.confirm_index <= entry_i]
        if not opp:
            continue
        stop_swing = max(opp, key=lambda s: s.pivot_index)
        stop_level = stop_swing.level
        # sanity: stop must be on the correct side of entry
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
    """First confirmed swing after entry (pivot_index > entry_i), favorable
    direction, level beyond entry. Returns (level, confirm_index) or None."""
    fav_kind = "high" if direction == "long" else "low"
    cand = [s for s in swings if s.kind == fav_kind and s.pivot_index > entry_i]
    for s in sorted(cand, key=lambda x: x.pivot_index):
        if direction == "long" and s.level > entry_px:
            return s.level, s.confirm_index
        if direction == "short" and s.level < entry_px:
            return s.level, s.confirm_index
    return None


def simulate_bot(candles, direction, leverage, tick):
    """WITHDRAWAL MODEL: each trade sized off fixed $600 wallet. Wins are
    banked (withdrawn), losses booked. Per-trade floor: cap loss at $100
    (equity floor $500 on $600 wallet). Reports NET REALIZED = wins - losses.
    """
    setups, swings = build_setup_signals(candles, direction, tick)
    trades: list[Trade] = []
    open_t: Optional[Trade] = None
    floor_hits = 0
    liquidations = 0
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
            worst_px = lo if open_t.direction == "long" else hi
            u = upnl(open_t, worst_px)
            if u < open_t.worst_upnl:
                open_t.worst_upnl = u
            # per-trade equity = WALLET_BASE + upnl; floor at $500 = loss of $100
            equity_now = WALLET_BASE + u
            if equity_now <= 0:
                liquidations += 1
                close_trade(open_t, j, ts, worst_px, "floor")
                trades.append(open_t); open_t = None
            elif equity_now <= FLOOR:
                floor_hits += 1
                close_trade(open_t, j, ts, worst_px, "floor")
                trades.append(open_t); open_t = None

        # Stop (confirmed close beyond setup opposite pivot)
        if open_t is not None:
            if (open_t.direction == "long" and cl < open_t.stop_level) or \
               (open_t.direction == "short" and cl > open_t.stop_level):
                close_trade(open_t, j, ts, cl, "stop")
                trades.append(open_t); open_t = None

        # TP (favorable pivot confirmed → exit at confirm candle close)
        if open_t is not None and open_t.tp_confirm_i is not None and j >= open_t.tp_confirm_i:
            close_trade(open_t, j, ts, cl, "tp")
            trades.append(open_t); open_t = None

        # Book realized + DD tracking on each close
        while trades and getattr(trades[-1], "_booked", False) is False:
            trades[-1]._booked = True
            running_realized += trades[-1].pnl
            peak_real = max(peak_real, running_realized)
            dd = peak_real - running_realized
            if dd > max_dd:
                max_dd = dd

        # Entry (single, no DCA)
        if open_t is None and j in by_i:
            for s in by_i[j]:
                fav = next_favorable_pivot(swings, direction, j, s["entry_px"])
                if fav is None:
                    continue
                tp_level, tp_confirm_i = fav
                t = open_trade(direction, j, ts, cl, WALLET_BASE, leverage,
                               tp_level, s["stop_level"])
                t.tp_confirm_i = tp_confirm_i
                open_t = t
                break

    if open_t is not None:
        open_t.outcome = "open"
        trades.append(open_t)

    return {
        "trades": trades,
        "wallet": WALLET_BASE + running_realized,  # cumulative if kept
        "realized": running_realized, "max_dd": max_dd,
        "floor_hits": floor_hits, "liquidations": liquidations,
    }




# Monkey-patch Trade to allow tp_confirm_i attribute
Trade.tp_confirm_i = None


def summarize(res, label):
    trades = res["trades"]
    wins = [t for t in trades if t.outcome == "tp"]
    losses_stop = [t for t in trades if t.outcome == "stop"]
    losses_floor = [t for t in trades if t.outcome == "floor"]
    losses = losses_stop + losses_floor
    openn = [t for t in trades if t.outcome == "open"]
    n = len(trades)
    net = sum(t.pnl for t in trades if t.outcome != "open")
    fees = sum(t.fees for t in trades)
    slip = sum(t.slip_cost for t in trades)
    gross = net + fees   # since pnl = gross_including_slip - fees; slip is embedded in fill
    avg_win = (sum(t.pnl for t in wins) / len(wins)) if wins else 0.0
    avg_loss = (sum(t.pnl for t in losses) / len(losses)) if losses else 0.0
    ratio = (avg_win / abs(avg_loss)) if avg_loss < 0 else float("inf") if wins else 0.0
    worst = min((t.pnl for t in losses), default=0.0)
    avg_hold = (
        sum((t.exit_i - t.entry_i) for t in trades if t.exit_i is not None)
        / max(1, sum(1 for t in trades if t.exit_i is not None))
    )
    # avg pivot distance
    def _pct(t, kind):
        if kind == "tp":
            return abs(t.tp_level - t.fill_px) / t.fill_px * 100
        return abs(t.stop_level - t.fill_px) / t.fill_px * 100
    avg_tp_dist = (sum(_pct(t, "tp") for t in trades) / n) if n else 0.0
    avg_stop_dist = (sum(_pct(t, "stop") for t in trades) / n) if n else 0.0
    return {
        "label": label, "n": n, "wins": len(wins),
        "stops": len(losses_stop), "floors": len(losses_floor), "open": len(openn),
        "win_rate": (len(wins) / n * 100) if n else 0.0,
        "net": net, "gross": gross, "fees": fees, "slip": slip,
        "avg_win": avg_win, "avg_loss": avg_loss, "ratio": ratio,
        "worst": worst, "avg_hold": avg_hold,
        "avg_tp_dist_pct": avg_tp_dist, "avg_stop_dist_pct": avg_stop_dist,
        "wallet": res["wallet"], "max_dd": res["max_dd"],
        "floor_hits": res["floor_hits"], "liquidations": res["liquidations"],
    }


def print_bot(s):
    print(f"\n  --- {s['label']} ---")
    print(f"    trades={s['n']}  wins={s['wins']}  stops={s['stops']}  floors={s['floors']}  open={s['open']}")
    print(f"    win rate: {s['win_rate']:.1f}%")
    print(f"    avg win: ${s['avg_win']:+.2f}   avg loss: ${s['avg_loss']:+.2f}   RATIO: {s['ratio']:.2f}")
    print(f"    gross ${s['gross']:+.2f}  fees ${s['fees']:.2f}  slip ${s['slip']:.2f}  NET ${s['net']:+.2f}")
    print(f"    worst single loss: ${s['worst']:+.2f}   ending wallet: ${s['wallet']:.2f}   max DD: ${s['max_dd']:.2f}")
    print(f"    floor_hits={s['floor_hits']}  liquidations={s['liquidations']}")
    print(f"    avg hold (5m candles): {s['avg_hold']:.1f}   avg TP dist: {s['avg_tp_dist_pct']:.2f}%   avg stop dist: {s['avg_stop_dist_pct']:.2f}%")


def main():
    sym = "BTC-USDT"
    hours = 720
    print("=" * 100)
    print("STRUCTURAL PIVOT-TO-PIVOT — single entry, two dedicated bots, sweep 25x/50x/100x")
    print("BTC-USDT · 30 days · 5m ApeX klines · $600/bot · $500 floor")
    print("TP: next confirmed favorable pivot   STOP: confirmed close beyond setup opposite pivot")
    print("Costs: taker 5 bps + slip 2 bps per fill (2 fills/trade).  Funding: NOT modeled.")
    print("=" * 100)

    feed = md.ApexPublicFeed()
    try:
        print(f"\nFetching {hours}h of 5m {sym} klines ...")
        f = feed.fetch_range(sym, 5, hours=hours)
        print(f"Got {len(f.candles)} candles  tick={f.tick}")
    except Exception as e:
        print("\n!!! DATA FETCH FAILED:")
        print(f"    {type(e).__name__}: {e}")
        traceback.print_exc()
        print("\nApeX egress likely blocked — must run on Railway.")
        return

    all_summaries = {}
    for lev in (25, 50, 100):
        print("\n" + "=" * 100)
        print(f"LEVERAGE {lev}x   |   margin_fraction = {NOTIONAL_CONST/lev:.3f}  "
              f"margin/trade = ${NOTIONAL_CONST/lev * WALLET_BASE:.2f}  "
              f"notional/trade = ${NOTIONAL_CONST * WALLET_BASE:.2f}")
        print("=" * 100)
        res_l = simulate_bot(f.candles, "long", lev, f.tick)
        res_s = simulate_bot(f.candles, "short", lev, f.tick)
        sl = summarize(res_l, f"BOT LONG  @ {lev}x")
        ss = summarize(res_s, f"BOT SHORT @ {lev}x")
        print_bot(sl); print_bot(ss)
        combined_net = sl["net"] + ss["net"]
        combined_dd = sl["max_dd"] + ss["max_dd"]
        print(f"\n  --- COMBINED @ {lev}x (on $1,200) ---")
        print(f"    NET: ${combined_net:+.2f}   combined max DD: ${combined_dd:.2f}")
        print(f"    total trades: {sl['n'] + ss['n']}   total wins: {sl['wins'] + ss['wins']}")
        all_summaries[lev] = (sl, ss, combined_net, combined_dd)

    print("\n" + "=" * 100)
    print("SUMMARY TABLE — NET on $1,200, avg-win/avg-loss RATIO per bot")
    print("=" * 100)
    print(f"  {'lev':>5}  {'LONG net':>10}  {'LONG ratio':>10}  {'SHORT net':>10}  {'SHORT ratio':>11}  {'COMBINED':>10}  {'DD':>8}")
    for lev, (sl, ss, cn, cdd) in all_summaries.items():
        print(f"  {lev:>4}x  ${sl['net']:>+9.2f}  {sl['ratio']:>10.2f}  ${ss['net']:>+9.2f}  {ss['ratio']:>11.2f}  ${cn:>+9.2f}  ${cdd:>7.2f}")

    print("\n" + "=" * 100)
    print("PLAIN ASSESSMENT")
    print("=" * 100)
    best_lev = max(all_summaries.keys(), key=lambda k: all_summaries[k][2])
    sl_b, ss_b, cn_b, cdd_b = all_summaries[best_lev]
    avg_ratio = ((sl_b["ratio"] if sl_b["ratio"] != float("inf") else 0) +
                 (ss_b["ratio"] if ss_b["ratio"] != float("inf") else 0)) / 2
    verdict = "PROFITABLE" if cn_b > 0 else "NET-NEGATIVE"
    print(f"* Best leverage: {best_lev}x  combined NET ${cn_b:+.2f}  combined DD ${cdd_b:.2f}   → {verdict}")
    print(f"* Avg win/loss RATIO at best lev: ~{avg_ratio:.2f}  (target ≥1.0; prior tests ran ~0.17 = -6:1 disease)")
    print(f"* Long bot took {sl_b['n']} trades; short bot took {ss_b['n']} trades")
    print("* Structural exits mean wins and losses scale with the same pivot geometry —")
    print("  the win/loss ratio number above is the direct test of whether that cures the")
    print("  -6:1 asymmetry.")


if __name__ == "__main__":
    main()
