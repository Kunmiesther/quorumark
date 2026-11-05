"""W1 30d BTC — withdrawal model + 5m BOS EXIT, NO 1H EMA trend filter.

Owner ask: drop the EMA filter entirely; keep only the BOS exit change.

Everything else identical to backtest_pnl_withdraw_1h_bosexit.py:
  $600 fixed per campaign, 100x, 5-tranche DCA at confirmed 5m break-and-retest,
  TP 50/30/20 @ +50/+55/+60% margin ROI, one-at-a-time.
  Wins withdrawn, wallet reset to $600, losses booked.
  BOS: confirmed 5m close beyond MOST-RECENT tranche's frozen zone.
  Stop ARMS only after first resize (spec: active_after=first_rebalance).
  Fees taker 5bps + slip 2bps every fill. Funding NOT modeled.
Data: ApeX public 5m klines, BTC-USDT, 30 days. Strategy files untouched.
"""
from __future__ import annotations
import traceback

import accumulator_signal as sig
import market_data as md
import backtest_pnl_dca_1h_trendfilter as base
import backtest_pnl_withdraw_1h_bosexit as bosmod


def main():
    sym = "BTC-USDT"
    hours = 720
    print("=" * 92)
    print("W1 30d BTC — WITHDRAWAL model + 5m BOS EXIT, NO EMA TREND FILTER")
    print("BOS: confirmed 5m close beyond most-recent tranche zone (S26 frozen zone).")
    print("Stop arms only AFTER first resize (spec: active_after=first_rebalance).")
    print("$600 fixed per campaign; wins withdrawn; wallet reset; losses booked.")
    print("100x, 5-tranche DCA, TP 50/30/20 @ +50/+55/+60% margin ROI.")
    print("Fees taker 5bps + slip 2bps per fill. Funding NOT modeled.")
    print("=" * 92)

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
        tm = mf * bosmod.WALLET_BASE
        tn = tm * base.LEVERAGE
        print(f"sizing: mf={mf:.3f}  margin/tranche=${tm:.2f}  notional/tranche=${tn:.2f}  cap={base.MAX_TRANCHES} tranches")

        # No filter: trend_at[j] returns whatever the direction is (long or short),
        # so we build a stub that always agrees. Simpler: monkey — just build a map
        # that returns each side. Since the veto is `trend_at[j] != d`, we need it
        # to equal EACH direction it's compared to. Use a sentinel that never
        # vetoes by replacing the veto path: use a dict-like that returns d itself.
        class AlwaysAgree:
            def __getitem__(self, j): return "__any__"
        # Patch: temporarily replace comparison — easier to just pass an object
        # and monkeypatch the filter check. Cleanest: build trend_at as a per-index
        # list of None and modify simulate to skip veto when None.
        # Simplest working approach: pass a defaultdict where every value equals
        # whatever's asked. We'll wrap by making the veto check pass unconditionally
        # via subclass:
        class NoVeto:
            def __getitem__(self, j): return None
        # Monkeypatch: override the filter comparison by wrapping simulate.

        # Cleanest: copy the simulate loop with the veto removed.
        candles = f.candles
        entries_long, entries_short = cl_l, cl_s
        evs = []
        for r in entries_long:
            evs.append((r.retest_index, "long", float(candles[r.retest_index][base.CLOSE]), r.break_event.zone))
        for r in entries_short:
            evs.append((r.retest_index, "short", float(candles[r.retest_index][base.CLOSE]), r.break_event.zone))
        evs.sort(key=lambda x: x[0])
        ev_by_i: dict[int, list] = {}
        for i, d, px, z in evs:
            ev_by_i.setdefault(i, []).append((d, px, z))

        state = {"wallet": bosmod.WALLET_BASE, "campaigns": [], "open": None, "halted": False}
        considered = 0

        def reset_after_close():
            if not state["campaigns"]: return
            last = state["campaigns"][-1]
            if last.outcome == "open": return
            state["wallet"] = bosmod.WALLET_BASE

        for j in range(len(candles)):
            c = candles[j]
            hi, lo, cl = float(c[base.HIGH]), float(c[base.LOW]), float(c[base.CLOSE])
            if state["open"] is not None:
                base.track_extremes(state["open"], hi, lo)

            prev = len(state["campaigns"])
            bosmod.bos_exit(state, j, cl)
            if len(state["campaigns"]) > prev:
                reset_after_close()

            prev = len(state["campaigns"])
            base.try_tp(state, j, hi, lo)
            if len(state["campaigns"]) > prev:
                reset_after_close()

            pos = state["open"]
            if pos is not None and len(pos.tranches) < base.MAX_TRANCHES and j in ev_by_i:
                for d2, px2, z2 in ev_by_i[j]:
                    if d2 != pos.direction: continue
                    better = (px2 < pos.last_entry_px) if pos.direction == "long" else (px2 > pos.last_entry_px)
                    if better:
                        bosmod.open_tranche_z(pos, px2, tn, z2)
                        pos.max_tranches_reached = max(pos.max_tranches_reached, len(pos.tranches))
                        if not any(pos.rung_done):
                            pos.original_total_qty = 0.0
                        break

            if state["open"] is None and j in ev_by_i:
                for d, px, z in ev_by_i[j]:
                    considered += 1
                    pos = base.Campaign(d, j, float(c[base.TS]))
                    bosmod.open_tranche_z(pos, px, tn, z)
                    pos.max_tranches_reached = 1
                    base.track_extremes(pos, px, px)
                    state["open"] = pos
                    break

        if state["open"] is not None:
            state["open"].exit_i = len(candles) - 1
            state["campaigns"].append(state["open"])
            state["open"] = None

        s = bosmod.summarize(state); s["considered"] = considered

        print("\n" + "=" * 92)
        print("RESULTS — withdrawal + 5m BOS EXIT, NO EMA filter (30d BTC)")
        print("=" * 92)
        def kv(label, val, fmt="{:>16.2f}"):
            print(f"  {label:<40}" + fmt.format(val))
        def kvi(label, val):
            print(f"  {label:<40}" + "{:>16d}".format(val))
        kvi("5m signals considered (all taken)", s["considered"])
        kvi("campaigns opened",      s["n"])
        kvi("wins (banked)",         s["wins"])
        kvi("losses",                s["losses"])
        kvi("closes: tp_full",       s["tpf"])
        kvi("closes: bos_stop",      s["bos"])
        kvi("closes: open at end",   s["op"])
        kvi("liquidations",          s["liq"])
        kv("avg tranches/campaign",  s["avg_tr"])
        kvi("max tranches",          s["max_tr"])
        kv("win rate %",             s["win_rate"])
        kv("TOTAL WITHDRAWN $",      s["withdrawn"])
        kv("TOTAL LOSSES $",         s["losses_sum"])
        kv("*** NET REALIZED $ ***", s["net_realized"])
        kv("avg win $",              s["avg_win"])
        kv("avg loss $",             s["avg_loss"])
        kv("worst single loss $",    s["worst_loss"])
        kv("avg hold (5m candles)",  s["avg_hold"])
        kv("worst unrealized $",     s["worst_upnl"])

        # Comparison vs filtered BOS runs
        print("\n  vs BOS+EMA filter variants (prior run, same window):")
        print(f"    NO FILTER : ${s['net_realized']:+.2f}")
        print("    EMA50/21/15: see backtest_pnl_withdraw_1h_bosexit output")

        print("\n" + "=" * 92)
        print("PLAIN ASSESSMENT")
        print("=" * 92)
        verdict = "NET-POSITIVE" if s["net_realized"] > 0 else "NET-NEGATIVE"
        print(f"* Verdict: {verdict}  net=${s['net_realized']:+.2f} over 30d BTC")
        print(f"* campaigns={s['n']}  win_rate={s['win_rate']:.1f}%  "
              f"avg_win=${s['avg_win']:.2f}  avg_loss=${s['avg_loss']:.2f}  "
              f"tp_full={s['tpf']}  bos_stop={s['bos']}")
        print("* Removing the 1H trend filter takes every confirmed 5m retest in both")
        print("  directions. More trades = more wins AND more losses; whether that helps")
        print("  or hurts depends on whether counter-trend entries were losing more than")
        print("  they were winning under the filter.")

    except Exception as e:
        print("\n!!! DATA FETCH / RUN FAILED — reporting honestly:")
        print(f"    {type(e).__name__}: {e}")
        traceback.print_exc()
        print("\nIf ApeX egress blocked, must run on Railway.")


if __name__ == "__main__":
    main()
