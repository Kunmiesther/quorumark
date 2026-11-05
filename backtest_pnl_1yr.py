"""1-YEAR two-bot structural strategy backtest — BTC-USDT.

Same strategy as backtest_pnl_limit_tp.py (LIMIT-TP-AT-PIVOT, flat margin,
two independent bots, single entry). Only differences: (a) tries to fetch
1 year of 5m candles by paginating ApeX klines back as far as the venue
serves, (b) reports the ACTUAL span covered (never fabricates), (c) adds
month-by-month path + true peak-to-trough drawdown on combined equity.

Strategy files untouched.
"""
from __future__ import annotations

import time
import traceback
from datetime import datetime, timezone
from typing import Optional

import market_data as md
from backtest_pnl_limit_tp import (
    WALLET_BASE, FLOOR, MARGIN_FRACTION,
    simulate_bot, summarize, print_bot,
)

TS = 0


def fetch_max_history(symbol: str, interval_min: int, target_hours: int):
    """Page BACKWARD from now, stitching until the venue stops giving new
    candles OR we hit target_hours. Reports actual span. Never fabricates.

    Reuses market_data primitives. Does NOT use fetch_range (which raises
    when it can't reach `hours`); we want "give me what you actually have."
    """
    feed = md.ApexPublicFeed()
    tick = feed.tick_size(symbol)
    step_ms = interval_min * 60_000
    fetched_at = int(time.time() * 1000)
    want_candles = (target_hours * 3_600_000) // step_ms

    by_ts: dict[int, list[float]] = {}
    end_sec = fetched_at // 1000
    pages = 0
    stagnant = 0
    last_report = 0
    started = time.time()
    print(f"Paginating {symbol} {interval_min}m klines backward from now …")
    while len(by_ts) < want_candles:
        try:
            body = feed.klines_raw(symbol, interval_min,
                                   limit=md.MAX_LIMIT, end_sec=end_sec)
        except md.FeedTransportError as e:
            print(f"  transport error at page {pages}: {e} — stopping fetch")
            break
        try:
            rows = md.parse_klines(body, symbol.replace("-", ""),
                                   interval_min, md.MAX_LIMIT)
        except md.FeedShapeError as e:
            print(f"  shape error at page {pages}: {e} — stopping fetch")
            break
        pages += 1
        if not rows:
            print(f"  page {pages}: venue returned 0 rows — history exhausted")
            break
        before = len(by_ts)
        for c in rows:
            by_ts[int(c[0])] = c
        added = len(by_ts) - before
        if added == 0:
            stagnant += 1
            if stagnant >= 2:
                print(f"  page {pages}: no new candles two pages running — history exhausted")
                break
        else:
            stagnant = 0
        end_sec = (int(rows[0][0]) - step_ms) // 1000

        # progress log every ~100 pages
        if pages - last_report >= 100:
            first_ts = min(by_ts)
            last_ts = max(by_ts)
            span_days = (last_ts - first_ts) / 86_400_000
            print(f"  page {pages}: {len(by_ts):,} candles, span {span_days:.1f} days, "
                  f"oldest={datetime.fromtimestamp(first_ts/1000, tz=timezone.utc):%Y-%m-%d}")
            last_report = pages

        # crude rate-limit friendliness
        time.sleep(0.05)

    candles = [by_ts[k] for k in sorted(by_ts)]
    completed = md.drop_incomplete(candles, interval_min, fetched_at)
    # validate — will raise on any gap so we know if history has holes
    try:
        md.validate_series(completed, interval_min, symbol)
        gap_note = "series is continuous (no gaps)"
    except md.FeedIntegrityError as e:
        gap_note = f"WARN: gap detected → {e}. Will skip validation and use as-is."
        # We *must not* forward-fill. Best we can do: report and use the
        # longest continuous tail so backtest indices stay meaningful.
        completed = _longest_continuous_tail(completed, interval_min)

    elapsed = time.time() - started
    first_ts = int(completed[0][TS]); last_ts = int(completed[-1][TS])
    print(f"Fetched {len(completed):,} candles across {pages} pages in {elapsed:.1f}s")
    print(f"  first candle: {datetime.fromtimestamp(first_ts/1000, tz=timezone.utc):%Y-%m-%d %H:%M} UTC")
    print(f"  last  candle: {datetime.fromtimestamp(last_ts/1000, tz=timezone.utc):%Y-%m-%d %H:%M} UTC")
    print(f"  span: {(last_ts-first_ts)/86_400_000:.1f} days · {gap_note}")
    return completed, tick, first_ts, last_ts


def _longest_continuous_tail(candles, interval_min):
    step_ms = interval_min * 60_000
    # walk from newest backward while step is constant
    end = len(candles)
    start = end - 1
    while start > 0:
        if candles[start][TS] - candles[start-1][TS] != step_ms:
            break
        start -= 1
    return candles[start:end]


def month_key(ts_ms: float) -> str:
    dt = datetime.fromtimestamp(ts_ms/1000, tz=timezone.utc)
    return f"{dt.year:04d}-{dt.month:02d}"


def build_equity_curve(long_trades, short_trades, first_ts, last_ts):
    """Combined equity curve over time. Booked at each trade exit_ts.
    Returns list of (ts_ms, cumulative_pnl). Anchored at first_ts=0."""
    events = []
    for t in long_trades + short_trades:
        if t.exit_ts is not None and t.outcome != "open":
            events.append((float(t.exit_ts), float(t.pnl)))
    events.sort(key=lambda x: x[0])
    curve = [(float(first_ts), 0.0)]
    cum = 0.0
    for ts, pnl in events:
        cum += pnl
        curve.append((ts, cum))
    curve.append((float(last_ts), cum))
    return curve, events


def max_drawdown(curve):
    peak = curve[0][1]; mdd = 0.0; peak_ts = curve[0][0]; trough_ts = curve[0][0]
    mdd_peak_ts = peak_ts; mdd_trough_ts = trough_ts
    for ts, v in curve:
        if v > peak:
            peak = v; peak_ts = ts
        dd = peak - v
        if dd > mdd:
            mdd = dd; mdd_peak_ts = peak_ts; mdd_trough_ts = ts
    return mdd, mdd_peak_ts, mdd_trough_ts


def per_month(events):
    m: dict[str, float] = {}
    for ts, pnl in events:
        k = month_key(ts)
        m[k] = m.get(k, 0.0) + pnl
    return m


def longest_losing_streak_months(month_pnl_sorted):
    best = 0; cur = 0
    for _, v in month_pnl_sorted:
        if v < 0:
            cur += 1; best = max(best, cur)
        else:
            cur = 0
    return best


def longest_losing_streak_trades(events):
    best = 0; cur = 0
    for _, pnl in events:
        if pnl < 0:
            cur += 1; best = max(best, cur)
        else:
            cur = 0
    return best


def main():
    sym = "BTC-USDT"
    target_hours = 24 * 365   # 1 year
    print("=" * 100)
    print("1-YEAR BACKTEST · BTC-USDT · two-bot structural (limit-TP-at-pivot, flat margin)")
    print(f"Target: {target_hours}h ≈ 365d of 5m candles ({target_hours*12:,} candles)")
    print("Sweep: 25x / 50x / 100x   ·   $600/bot   ·   $500 floor   ·   $60 flat margin")
    print("Costs: taker 5bps + slip 2bps per fill.  Funding: NOT modeled.")
    print("=" * 100)

    try:
        candles, tick, first_ts, last_ts = fetch_max_history(sym, 5, target_hours)
    except Exception as e:
        print("\n!!! DATA FETCH FAILED — ApeX egress or venue error.")
        print(f"    {type(e).__name__}: {e}")
        traceback.print_exc()
        print("\nApeX egress blocked or venue error — must run on Railway or retry later.")
        return

    n = len(candles)
    span_days = (last_ts - first_ts) / 86_400_000
    coverage_pct = span_days / 365 * 100
    print(f"\nACTUAL DATASET USED: {n:,} candles · {span_days:.1f} days "
          f"({coverage_pct:.0f}% of a year) · tick={tick}\n")

    results_by_lev = {}
    for lev in (25, 50, 100):
        margin = MARGIN_FRACTION * WALLET_BASE
        notional = margin * lev
        print("=" * 100)
        print(f"LEVERAGE {lev}x   |   flat margin=${margin:.0f}   notional=${notional:.0f}")
        print("=" * 100)
        rl = simulate_bot(candles, "long", lev, tick)
        rs = simulate_bot(candles, "short", lev, tick)
        sl = summarize(rl, f"BOT LONG  @ {lev}x")
        ss = summarize(rs, f"BOT SHORT @ {lev}x")
        print_bot(sl); print_bot(ss)

        curve, events = build_equity_curve(rl["trades"], rs["trades"], first_ts, last_ts)
        mdd, peak_ts, trough_ts = max_drawdown(curve)
        combined_net = sl["net"] + ss["net"]
        pct_return = combined_net / 1200.0 * 100
        month_pnl = per_month(events)
        months_sorted = sorted(month_pnl.items())
        winning_months = sum(1 for _, v in months_sorted if v > 0)
        losing_months = sum(1 for _, v in months_sorted if v < 0)
        worst_month = min(months_sorted, key=lambda kv: kv[1], default=("n/a", 0.0))
        best_month = max(months_sorted, key=lambda kv: kv[1], default=("n/a", 0.0))
        losing_streak_m = longest_losing_streak_months(months_sorted)
        losing_streak_t = longest_losing_streak_trades(events)

        print(f"\n  --- COMBINED @ {lev}x (on $1,200) ---")
        print(f"    NET: ${combined_net:+.2f}   return: {pct_return:+.1f}%")
        print(f"    total trades: {sl['n']+ss['n']}   wins: {sl['wins']+ss['wins']}   stops: {sl['stops']+ss['stops']}   floors: {sl['floors']+ss['floors']}")
        print(f"    MAX DRAWDOWN (peak→trough on combined realized): ${mdd:.2f}")
        if mdd > 0:
            print(f"      peak  @ {datetime.fromtimestamp(peak_ts/1000, tz=timezone.utc):%Y-%m-%d}")
            print(f"      trough@ {datetime.fromtimestamp(trough_ts/1000, tz=timezone.utc):%Y-%m-%d}")
        print(f"    profitable months: {winning_months}   losing months: {losing_months}   flat: {len(months_sorted)-winning_months-losing_months}")
        print(f"    best  month: {best_month[0]}  ${best_month[1]:+.2f}")
        print(f"    worst month: {worst_month[0]}  ${worst_month[1]:+.2f}")
        print(f"    longest losing streak (months): {losing_streak_m}   (consecutive losing trades): {losing_streak_t}")

        print(f"\n    MONTH-BY-MONTH combined net PnL:")
        print(f"      {'month':>8}  {'net':>10}")
        for k, v in months_sorted:
            marker = " ✓" if v > 0 else (" ✗" if v < 0 else "  ")
            print(f"      {k:>8}  ${v:>+9.2f}{marker}")

        results_by_lev[lev] = {
            "long": sl, "short": ss, "combined": combined_net, "pct": pct_return,
            "mdd": mdd, "months": months_sorted,
            "winning_months": winning_months, "losing_months": losing_months,
            "worst_month": worst_month, "best_month": best_month,
            "streak_m": losing_streak_m, "streak_t": losing_streak_t,
        }

    print("\n" + "=" * 100)
    print("SUMMARY — all leverage levels")
    print("=" * 100)
    print(f"  {'lev':>4}  {'notional':>9}  {'NET':>11}  {'return':>8}  {'MDD':>9}  {'win_mo':>7}  {'lose_mo':>7}  {'worst_mo':>10}")
    for lev, r in results_by_lev.items():
        wm = r["worst_month"]
        print(f"  {lev:>3}x  ${MARGIN_FRACTION*WALLET_BASE*lev:>8.0f}  "
              f"${r['combined']:>+10.2f}  {r['pct']:>+7.1f}%  ${r['mdd']:>8.2f}  "
              f"{r['winning_months']:>7}  {r['losing_months']:>7}  ${wm[1]:>+9.2f}")

    print("\n" + "=" * 100)
    print("PLAIN ASSESSMENT")
    print("=" * 100)
    best_lev = max(results_by_lev.keys(), key=lambda k: results_by_lev[k]["combined"])
    r = results_by_lev[best_lev]
    verdict = "NET-POSITIVE" if r["combined"] > 0 else "NET-NEGATIVE"
    print(f"* Actual span backtested: {span_days:.1f} days ({coverage_pct:.0f}% of a full year).")
    print(f"* Best NET leverage: {best_lev}x → ${r['combined']:+.2f} ({r['pct']:+.1f}%) on $1,200.")
    print(f"* Worst drawdown at {best_lev}x: ${r['mdd']:.2f}  ({r['mdd']/1200*100:.1f}% of $1,200).")
    print(f"* Worst month at {best_lev}x: {r['worst_month'][0]} ${r['worst_month'][1]:+.2f}.")
    print(f"* Losing months / total: {r['losing_months']} / {len(r['months'])}   "
          f"longest losing streak: {r['streak_m']} months, {r['streak_t']} trades.")
    concentrated = False
    if r["months"]:
        top2 = sum(v for _, v in sorted(r["months"], key=lambda kv: kv[1], reverse=True)[:2])
        if r["combined"] > 0 and top2 >= 0.7 * r["combined"]:
            concentrated = True
    print(f"* Profit concentration: top-2 months = "
          f"{100*sum(v for _,v in sorted(r['months'], key=lambda kv: kv[1], reverse=True)[:2])/max(r['combined'],1e-9):.0f}% "
          f"of total {'→ CONCENTRATED, fragile' if concentrated else '→ reasonably spread'}.")
    print(f"* Overall verdict at {best_lev}x: {verdict}.")


if __name__ == "__main__":
    main()
