"""W1 30d BTC — CORRECTED withdrawal model + 1H EMA(50/21/15) trend filter,
BUT the $500 equity-floor exit is REPLACED with a confirmed 5m BREAK-OF-STRUCTURE
exit against the frozen entry zone.

BOS rule (per accumulator_signal zone edges — SAME edges the signal uses for
expired_breach; this is the owner-ratified "confirmed break, not a fakeout"):
  Long : any completed 5m candle whose CLOSE < most_recent_tranche.zone.lower
  Short: any completed 5m candle whose CLOSE > most_recent_tranche.zone.upper

Spec faithfulness: STOP arms only AFTER the first resize (spec S: active_after
first_rebalance). Before the first resize the position holds through adverse
movement and averages down instead. Documented.

Everything else identical to backtest_pnl_withdraw_1h_trendfilter.py:
  $600 fixed per campaign, 100x, 5-tranche DCA, TP 50/30/20 @ +50/+55/+60%
  margin ROI, one-at-a-time, wins withdrawn / wallet reset, losses booked.
  Fees taker 5bps + slip 2bps every fill. Funding NOT modeled.
Data: ApeX public 5m klines, BTC-USDT, 30 days.
Strategy files untouched.
"""
from __future__ import annotations
import traceback
from dataclasses import dataclass, field
from typing import Optional

import accumulator_signal as sig
import market_data as md
import backtest_pnl_dca_1h_trendfilter as base

WALLET_BASE = 600.0


@dataclass
class TrancheZ:
    qty: float
    entry_px: float
    zlower: float
    zupper: float


def open_tranche_z(pos, price, tranche_notional, zone):
    qty = tranche_notional / price
    base.apply_fill(pos, qty, price)
    pos.tranches.append(TrancheZ(qty, price, float(zone.lower), float(zone.upper)))
    pos.last_entry_px = price


def bos_exit(state, j, cl):
    """Confirmed-5m-close BOS against MOST-RECENT tranche's frozen zone.
    Arms only after first resize (len(tranches) >= 2)."""
    pos = state["open"]
    if pos is None or len(pos.tranches) < 2:
        return False
    last = pos.tranches[-1]
    trig = False
    if pos.direction == "long" and cl < last.zlower:
        trig = True; px = cl
    elif pos.direction == "short" and cl > last.zupper:
        trig = True; px = cl
    if not trig:
        return False
    base.close_qty(pos, pos.total_qty(), px)
    pos.exit_i = j
    pos.outcome = "bos_stop"
    state["wallet"] += pos.gross_pnl - pos.fees - pos.slippage
    state["campaigns"].append(pos)
    state["open"] = None
    return True


def simulate_bos_withdraw(candles, entries_long, entries_short, trend_at, tn):
    # index events with their zone
    evs = []
    for r in entries_long:  evs.append((r.retest_index, "long",  float(candles[r.retest_index][base.CLOSE]), r.break_event.zone))
    for r in entries_short: evs.append((r.retest_index, "short", float(candles[r.retest_index][base.CLOSE]), r.break_event.zone))
    evs.sort(key=lambda x: x[0])
    ev_by_i: dict[int, list] = {}
    for i, d, px, z in evs:
        ev_by_i.setdefault(i, []).append((d, px, z))

    state = {"wallet": WALLET_BASE, "campaigns": [], "open": None, "halted": False}
    considered = 0
    vetoed = 0

    def reset_after_close():
        if not state["campaigns"]: return
        last = state["campaigns"][-1]
        if last.outcome == "open": return
        state["wallet"] = WALLET_BASE

    for j in range(len(candles)):
        c = candles[j]
        hi, lo, cl = float(c[base.HIGH]), float(c[base.LOW]), float(c[base.CLOSE])

        if state["open"] is not None:
            base.track_extremes(state["open"], hi, lo)

        # 1) BOS stop on completed close (only arms after first resize)
        prev = len(state["campaigns"])
        bos_exit(state, j, cl)
        if len(state["campaigns"]) > prev:
            reset_after_close()

        # 2) TP ladder
        prev = len(state["campaigns"])
        base.try_tp(state, j, hi, lo)
        if len(state["campaigns"]) > prev:
            reset_after_close()

        # 3) DCA add
        pos = state["open"]
        if pos is not None and len(pos.tranches) < base.MAX_TRANCHES and j in ev_by_i:
            for d2, px2, z2 in ev_by_i[j]:
                if d2 != pos.direction: continue
                better = (px2 < pos.last_entry_px) if pos.direction == "long" else (px2 > pos.last_entry_px)
                if better:
                    open_tranche_z(pos, px2, tn, z2)
                    pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
                    if not any(pos.rung_done):
                        pos.original_total_qty = 0.0
                    break

        # 4) New campaign (1H trend filter)
        if state["open"] is None and j in ev_by_i:
            for d, px, z in ev_by_i[j]:
                considered += 1
                if trend_at[j] != d:
                    vetoed += 1
                    continue
                pos = base.Campaign(d, j, float(c[base.TS]))
                open_tranche_z(pos, px, tn, z)
                pos.max_tranches_reached = 1
                base.track_extremes(pos, px, px)
                state["open"] = pos
                break

    if state["open"] is not None:
        state["open"].exit_i = len(candles) - 1
        state["campaigns"].append(state["open"])
        state["open"] = None
    return state, considered, vetoed


def summarize(state):
    camps = state["campaigns"]
    closed = [p for p in camps if p.outcome != "open"]
    wins = [p for p in closed if base.net(p) > 0]
    losses = [p for p in closed if base.net(p) <= 0]
    withdrawn = sum(base.net(p) for p in wins)
    losses_sum = sum(base.net(p) for p in losses)
    tpf = sum(1 for p in camps if p.outcome == "tp_full")
    bos = sum(1 for p in camps if p.outcome == "bos_stop")
    op = sum(1 for p in camps if p.outcome == "open")
    rung = [sum(1 for p in camps if p.rung_done[k]) for k in range(3)]
    holds = [(p.exit_i - p.open_i) for p in closed if p.exit_i is not None]
    worst_upnl = min((p.worst_unrealized_pnl for p in camps), default=0.0)
    liq = sum(1 for p in camps if -p.worst_unrealized_pnl >= WALLET_BASE)
    avg_tr = (sum(p.max_tranches_reached for p in camps)/len(camps)) if camps else 0.0
    max_tr = max((p.max_tranches_reached for p in camps), default=0)
    return dict(
        n=len(camps), closed=len(closed), wins=len(wins), losses=len(losses),
        tpf=tpf, bos=bos, op=op, rung=rung,
        withdrawn=withdrawn, losses_sum=losses_sum,
        net_realized=withdrawn + losses_sum,
        win_rate=(len(wins)/len(closed)*100) if closed else 0.0,
        avg_win=(withdrawn/len(wins)) if wins else 0.0,
        avg_loss=(losses_sum/len(losses)) if losses else 0.0,
        worst_loss=min((base.net(p) for p in losses), default=0.0),
        avg_hold=sum(holds)/len(holds) if holds else 0.0,
        avg_tr=avg_tr, max_tr=max_tr,
        worst_upnl=worst_upnl, liq=liq,
    )


def main():
    sym = "BTC-USDT"
    hours = 720
    print("="*92)
    print("W1 30d BTC — WITHDRAWAL model + 1H EMA filter + 5m BOS EXIT (replaces $500 floor)")
    print("BOS: confirmed 5m close beyond most-recent tranche zone (S26 frozen zone).")
    print("Stop arms only AFTER first resize (spec: active_after=first_rebalance).")
    print("$600 fixed per campaign; wins withdrawn; wallet reset; losses booked.")
    print("100x, 5-tranche DCA, TP 50/30/20 @ +50/+55/+60% margin ROI.")
    print("Fees taker 5bps + slip 2bps per fill. Funding NOT modeled.")
    print("="*92)

    feed = md.ApexPublicFeed()
    try:
        print(f"\n[{sym}] fetching {hours}h of 5m candles ...")
        f = feed.fetch_range(sym, 5, hours=hours)
        longs = sig.evaluate(f.candles, "long", f.tick)["entries"]
        shorts = sig.evaluate(f.candles, "short", f.tick)["entries"]
        cl_l = [r for r in longs if r.state == "confirmed"]
        cl_s = [r for r in shorts if r.state == "confirmed"]
        print(f"[{sym}] candles={len(f.candles)}  confirmed retests long={len(cl_l)} short={len(cl_s)}")

        mf = base.NOTIONAL_CONST / base.LEVERAGE
        tm = mf * WALLET_BASE
        tn = tm * base.LEVERAGE
        print(f"sizing: mf={mf:.3f}  margin/tranche=${tm:.2f}  notional/tranche=${tn:.2f}  cap={base.MAX_TRANCHES} tranches")

        results = {}
        for period in (50, 21, 15):
            trend_at = base.ema_trend_map(f.candles, period)
            state, considered, vetoed = simulate_bos_withdraw(f.candles, cl_l, cl_s, trend_at, tn)
            s = summarize(state); s["considered"] = considered; s["vetoed"] = vetoed
            results[period] = s

        print("\n" + "="*92)
        print("RESULTS — withdrawal + 1H EMA filter + 5m BOS EXIT (30d BTC)")
        print("="*92)
        print(f"  {'metric':<40}{'EMA50':>16}{'EMA21':>16}{'EMA15':>16}")
        def row(label, key, fmt="{:>16.2f}"):
            print(f"  {label:<40}" + "".join(fmt.format(results[p][key]) for p in (50,21,15)))
        def rowi(label, key):
            print(f"  {label:<40}" + "".join("{:>16d}".format(results[p][key]) for p in (50,21,15)))
        rowi("5m signals considered", "considered")
        rowi("counter-trend vetoed",  "vetoed")
        rowi("campaigns opened",      "n")
        rowi("wins (banked)",         "wins")
        rowi("losses",                "losses")
        rowi("closes: tp_full",       "tpf")
        rowi("closes: bos_stop",      "bos")
        rowi("closes: open at end",   "op")
        rowi("liquidations",          "liq")
        row("avg tranches/campaign",  "avg_tr")
        rowi("max tranches",          "max_tr")
        row("win rate %",             "win_rate")
        row("TOTAL WITHDRAWN $",      "withdrawn")
        row("TOTAL LOSSES $",         "losses_sum")
        row("*** NET REALIZED $ ***", "net_realized")
        row("avg win $",              "avg_win")
        row("avg loss $",             "avg_loss")
        row("worst single loss $",    "worst_loss")
        row("avg hold (5m candles)",  "avg_hold")
        row("worst unrealized $",     "worst_upnl")

        # Comparison vs the equity-floor variant
        FLOOR = {50: -1254.71, 21: -1154.51, 15: -1133.79}
        print("\n  vs floor-exit variant NET REALIZED (prior run):")
        for p in (50,21,15):
            d = results[p]["net_realized"] - FLOOR[p]
            print(f"    EMA{p}: BOS ${results[p]['net_realized']:+.2f}  vs floor ${FLOOR[p]:+.2f}   delta {d:+.2f}")

        print("\n" + "="*92)
        print("PLAIN ASSESSMENT")
        print("="*92)
        best_p = max(results, key=lambda k: results[k]["net_realized"])
        best = results[best_p]
        any_pos = any(results[p]["net_realized"] > 0 for p in results)
        print(f"* Any 1H EMA period NET-POSITIVE on 30d BTC under BOS exit? {'YES' if any_pos else 'NO'}")
        for p in (50,21,15):
            r = results[p]
            print(f"  - EMA{p}: net=${r['net_realized']:+.2f}  wins={r['wins']} losses={r['losses']}  "
                  f"bos={r['bos']} tp_full={r['tpf']}  avg_win=${r['avg_win']:.2f} avg_loss=${r['avg_loss']:.2f}")
        print(f"* Best config: EMA{best_p} at ${best['net_realized']:+.2f}")
        print("* BOS vs floor: BOS exits at the SIGNAL invalidation (zone break) rather than at a")
        print("  fixed -$100 dollar loss — losses tend to be SMALLER but more FREQUENT.")
        print("  Compare per-EMA above to see which regime wins on this data.")
        print("* Note: BOS arms only after first resize; single-tranche campaigns have no stop and")
        print("  either hit TP or ride to end-of-window (may show as 'open').")

    except Exception as e:
        print("\n!!! DATA FETCH / RUN FAILED — reporting honestly:")
        print(f"    {type(e).__name__}: {e}")
        traceback.print_exc()
        print("\nIf ApeX egress blocked, must run on Railway.")


if __name__ == "__main__":
    main()
