"""W1 30d BTC + 1H EMA trend filter (50/21/15) — CORRECTED withdrawal model.

Every campaign sizes off a FIXED $600 baseline. Winning-campaign profit is
BANKED (withdrawn) and the wallet resets to $600. Losing-campaign loss is
booked against total_losses; wallet is topped back to $600 externally.
Compounding is intentionally OFF — this reflects the owner's Life-Mode use.

Strategy files untouched. Reuses helpers from backtest_pnl_dca_1h_trendfilter.
"""
from __future__ import annotations
import traceback

import accumulator_signal as sig
import market_data as md
import backtest_pnl_dca_1h_trendfilter as base

WALLET_BASE = 600.0
HARD_FLOOR  = 500.0  # -$100 per campaign


def simulate_withdraw(candles, entries_long, entries_short, trend_at, tranche_notional):
    """Same event walk as base.simulate, but wallet RESETS to $600 after every
    closed campaign (win → profit banked; loss → loss booked). No compounding."""
    evs = []
    for r in entries_long:  evs.append((r.retest_index, "long", float(candles[r.retest_index][base.CLOSE])))
    for r in entries_short: evs.append((r.retest_index, "short", float(candles[r.retest_index][base.CLOSE])))
    evs.sort(key=lambda x: x[0])
    ev_by_i: dict[int, list] = {}
    for i, d, px in evs:
        ev_by_i.setdefault(i, []).append((d, px))

    state = {"wallet": WALLET_BASE, "campaigns": [], "open": None, "halted": False}
    considered = 0
    vetoed = 0

    def after_close_reset():
        # A campaign just closed → append happened inside base helpers, wallet
        # was updated with net PnL. Bank result, reset wallet to $600.
        if not state["campaigns"]:
            return
        # Only reset if the last campaign is closed (has exit_i and outcome != "open")
        last = state["campaigns"][-1]
        if last.outcome == "open":
            return
        state["wallet"] = WALLET_BASE
        state["halted"] = False  # never halt — top up externally

    for j in range(len(candles)):
        c = candles[j]
        hi, lo, cl = float(c[base.HIGH]), float(c[base.LOW]), float(c[base.CLOSE])

        if state["open"] is not None:
            base.track_extremes(state["open"], hi, lo)

        prev_count = len(state["campaigns"])
        base.check_floor(state, j, hi, lo, cl)
        if len(state["campaigns"]) > prev_count:
            after_close_reset()

        prev_count = len(state["campaigns"])
        base.try_tp(state, j, hi, lo)
        if len(state["campaigns"]) > prev_count:
            after_close_reset()

        # DCA add
        pos = state["open"]
        if pos is not None and len(pos.tranches) < base.MAX_TRANCHES and j in ev_by_i:
            for d2, px2 in ev_by_i[j]:
                if d2 != pos.direction: continue
                better = (px2 < pos.last_entry_px) if pos.direction == "long" else (px2 > pos.last_entry_px)
                if better:
                    base.open_tranche(pos, px2, tranche_notional)
                    pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
                    if not any(pos.rung_done):
                        pos.original_total_qty = 0.0
                    break

        # New campaign — trend filter applied
        if state["open"] is None and j in ev_by_i:
            for d, px in ev_by_i[j]:
                considered += 1
                trend = trend_at[j]
                if trend != d:
                    vetoed += 1
                    continue
                pos = base.Campaign(d, j, float(c[base.TS]))
                base.open_tranche(pos, px, tranche_notional)
                pos.max_tranches_reached = 1
                base.track_extremes(pos, px, px)
                state["open"] = pos
                break

    if state["open"] is not None:
        state["open"].exit_i = len(candles) - 1
        state["campaigns"].append(state["open"])
        state["open"] = None

    return state, considered, vetoed


def summarize_withdraw(state):
    camps = state["campaigns"]
    closed = [p for p in camps if p.outcome != "open"]
    wins = [p for p in closed if base.net(p) > 0]
    losses = [p for p in closed if base.net(p) <= 0]
    withdrawn = sum(base.net(p) for p in wins)
    losses_sum = sum(base.net(p) for p in losses)  # negative
    net_realized = withdrawn + losses_sum
    floor_hits = sum(1 for p in camps if p.outcome == "hard_floor")
    liq = sum(1 for p in camps if -p.worst_unrealized_pnl >= WALLET_BASE)

    # Old compounding model: what would ending wallet have been?
    # Reconstruct: start 600, add every campaign net (win or loss), keep running.
    compounded = WALLET_BASE
    for p in camps:
        if p.outcome != "open":
            compounded += base.net(p)
    old_ending = compounded
    old_net = compounded - WALLET_BASE

    return dict(
        n=len(camps),
        n_closed=len(closed),
        wins=len(wins),
        losses=len(losses),
        floor_hits=floor_hits,
        withdrawn=withdrawn,
        losses_sum=losses_sum,
        net_realized=net_realized,
        win_rate=(len(wins)/len(closed)*100) if closed else 0.0,
        avg_win=(withdrawn/len(wins)) if wins else 0.0,
        avg_loss=(losses_sum/len(losses)) if losses else 0.0,
        worst_loss=min((base.net(p) for p in losses), default=0.0),
        liq=liq,
        old_ending_wallet=old_ending,
        old_net=old_net,
    )


def main():
    sym = "BTC-USDT"
    hours = 720
    print("="*90)
    print("W1 30d BTC + 1H EMA trend filter (50/21/15) — CORRECTED WITHDRAWAL MODEL")
    print("Wallet fixed $600 per campaign. Profits banked (withdrawn); losses booked.")
    print("No compounding. Headline: NET REALIZED = total_withdrawn - total_losses.")
    print("100x, 5-tranche DCA, TP 50/30/20 @ +50/+55/+60% margin, $500 floor.")
    print("Fees taker 5bps + slip 2bps per fill. Funding NOT modeled.")
    print("="*90)

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
        print(f"sizing: mf={mf:.3f}  margin/tranche=${tm:.2f}  notional/tranche=${tn:.2f}  cap={base.MAX_TRANCHES}")
        print(f"WALLET MODEL: fixed ${WALLET_BASE:.0f} baseline every campaign; wins withdrawn; wallet reset after every close.")

        results = {}
        for period in (50, 21, 15):
            trend_at = base.ema_trend_map(f.candles, period)
            state, considered, vetoed = simulate_withdraw(f.candles, cl_l, cl_s, trend_at, tn)
            s = summarize_withdraw(state)
            s["considered"] = considered
            s["vetoed"] = vetoed
            results[period] = s

        print("\n" + "="*90)
        print("RESULTS — corrected withdrawal accounting")
        print("="*90)
        print(f"  {'metric':<40}{'EMA50':>15}{'EMA21':>15}{'EMA15':>15}")
        def row(label, key, fmt="{:>15.2f}"):
            print(f"  {label:<40}" + "".join(fmt.format(results[p][key]) for p in (50,21,15)))
        def rowi(label, key):
            print(f"  {label:<40}" + "".join("{:>15d}".format(results[p][key]) for p in (50,21,15)))
        rowi("5m signals considered",             "considered")
        rowi("counter-trend vetoed",              "vetoed")
        rowi("campaigns opened",                  "n")
        rowi("closed campaigns",                  "n_closed")
        rowi("wins (banked)",                     "wins")
        rowi("losses",                            "losses")
        rowi("floor hits",                        "floor_hits")
        rowi("liquidations",                      "liq")
        row("win rate %",                         "win_rate")
        row("TOTAL WITHDRAWN PROFIT $",           "withdrawn")
        row("TOTAL LOSSES $",                     "losses_sum")
        row("*** NET REALIZED $ ***",             "net_realized")
        row("avg win (withdrawn) $",              "avg_win")
        row("avg loss $",                         "avg_loss")
        row("worst single loss $",                "worst_loss")
        print()
        print("  For contrast — OLD compounding model (prior runs' number):")
        row("  old ending wallet $",              "old_ending_wallet")
        row("  old net vs $600 $",                "old_net")

        print("\n" + "="*90)
        print("PLAIN ASSESSMENT")
        print("="*90)
        best_p = max(results, key=lambda k: results[k]["net_realized"])
        best = results[best_p]
        any_pos = any(results[p]["net_realized"] > 0 for p in results)
        print(f"* Under CORRECTED withdrawal model, any EMA period NET-POSITIVE on 30d BTC? {'YES' if any_pos else 'NO'}")
        for p in (50, 21, 15):
            r = results[p]
            flipped = (r["net_realized"] > 0) and (r["old_net"] <= 0)
            print(f"  - EMA{p}: net_realized=${r['net_realized']:+.2f}  "
                  f"(old compounding said ${r['old_net']:+.2f})  "
                  f"wins={r['wins']} losses={r['losses']} floor={r['floor_hits']}"
                  + ("   <-- WITHDRAWAL FLIPS SIGN" if flipped else ""))
        print(f"* Best EMA period by NET REALIZED: EMA{best_p} at ${best['net_realized']:+.2f}")
        print(f"* Prior compounding W1-baseline was -$112.69. Withdrawal-model best: ${best['net_realized']:+.2f}  "
              f"(delta {best['net_realized'] - (-112.69):+.2f}).")
        survivable = best["net_realized"] > 0 and best["liq"] == 0 and best["floor_hits"] <= best["wins"]
        print(f"* Profitable AND survivable (net_realized > 0, no liquidations, wins >= floor hits)? "
              f"{'YES' if survivable else 'NO'} for best config EMA{best_p}.")

    except Exception as e:
        print("\n!!! DATA FETCH / RUN FAILED — reporting honestly:")
        print(f"    {type(e).__name__}: {e}")
        traceback.print_exc()
        print("\nIf ApeX egress blocked, must run on Railway.")


if __name__ == "__main__":
    main()
