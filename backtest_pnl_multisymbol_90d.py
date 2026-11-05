"""6-WALLET 90-DAY MULTI-SYMBOL BACKTEST — BTC / ETH / SOL.

Same structural strategy as backtest_pnl_limit_tp.py (LIMIT-TP-AT-PIVOT,
flat margin, single-entry, two independent bots per symbol). Scaled to:
  - 6 wallets: {BTC,ETH,SOL} × {long,short}
  - $1,000 / wallet ($6,000 total).  Floor = $833 (~16.7% drawdown, same
    ratio as the $600/$500 config).
  - 90 days of 5m candles per symbol.
  - Sweep 25x / 50x / 100x.  SOL capped at 50x (ApeX max on SOL).

Strategy files untouched. Real ApeX data — never fabricates.
"""
from __future__ import annotations

import time
import traceback
from datetime import datetime, timezone
from typing import Optional

import market_data as md
import backtest_pnl_limit_tp as base
from backtest_pnl_1yr import (
    fetch_max_history, build_equity_curve, max_drawdown, per_month,
)

# ---- override the sizing/floor constants used by base.simulate_bot ----
NEW_WALLET = 1000.0
NEW_FLOOR = 833.0
NEW_MARGIN_FRACTION = 0.10   # flat 10% → $100 margin
base.WALLET_BASE = NEW_WALLET
base.FLOOR = NEW_FLOOR
base.MARGIN_FRACTION = NEW_MARGIN_FRACTION

TS = 0

SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]
MAX_LEV = {"BTC-USDT": 100, "ETH-USDT": 100, "SOL-USDT": 50}


def print_wallet(s, header):
    print(f"\n    {header}")
    print(f"      trades={s['n']} closed={s['n_closed']}  wins={s['wins']}  stops={s['stops']}  floors={s['floors']}  open={s['open']}")
    print(f"      win rate: {s['win_rate']:.1f}%   TP fill rate: {(100*s['tp_filled']/s['tp_placed']) if s['tp_placed'] else 0.0:.1f}%  (placed={s['tp_placed']} filled={s['tp_filled']})")
    print(f"      avg win ${s['avg_win']:+.2f}   avg loss ${s['avg_loss']:+.2f}   W/L ratio {s['ratio']:.3f}")
    print(f"      NET ${s['net']:+.2f}  fees ${s['fees']:.2f}  slip ${s['slip']:.2f}")
    print(f"      worst single trade ${s['worst']:+.2f}   max DD ${s['max_dd']:.2f}   floors={s['floor_hits']}   liq={s['liquidations']}")


def main():
    target_hours = 24 * 90   # 90 days
    print("=" * 100)
    print("6-WALLET · 90-DAY · BTC + ETH + SOL · two-bot structural (limit-TP-at-pivot, flat margin)")
    print(f"Target: {target_hours}h = 90d of 5m candles/symbol (~{target_hours*12:,}/symbol)")
    print(f"Wallet: ${NEW_WALLET:.0f} × 6 = ${NEW_WALLET*6:.0f}   ·   floor ${NEW_FLOOR:.0f}   ·   flat margin ${NEW_WALLET*NEW_MARGIN_FRACTION:.0f}")
    print("Sweep: 25x / 50x / 100x (SOL CAPPED AT 50x — ApeX venue max)")
    print("Costs: taker 5bps + slip 2bps per fill.  Funding: NOT modeled.")
    print("=" * 100)

    # ---- fetch each symbol independently, report actual span ----
    data = {}
    for sym in SYMBOLS:
        print("")
        try:
            candles, tick, first_ts, last_ts = fetch_max_history(sym, 5, target_hours)
        except Exception as e:
            print(f"\n!!! FETCH FAILED for {sym}: {type(e).__name__}: {e}")
            traceback.print_exc()
            print("\nApeX egress blocked or venue error — must run on Railway.")
            return
        # trim to last 90 days if we got more (fetch_max_history pages until target)
        span_ms = target_hours * 3_600_000
        cutoff = int(candles[-1][TS]) - span_ms
        candles = [c for c in candles if int(c[TS]) >= cutoff]
        first_ts = int(candles[0][TS]); last_ts = int(candles[-1][TS])
        span_days = (last_ts - first_ts) / 86_400_000
        print(f"  {sym}: using last {len(candles):,} candles · {span_days:.1f} days")
        data[sym] = {"candles": candles, "tick": tick,
                     "first_ts": first_ts, "last_ts": last_ts, "span_days": span_days}

    # ---- run leverage sweep ----
    portfolio_by_lev: dict[int, dict] = {}
    for lev_req in (25, 50, 100):
        print("\n" + "=" * 100)
        print(f"LEVERAGE {lev_req}x  (SOL capped at {min(lev_req, MAX_LEV['SOL-USDT'])}x)")
        print("=" * 100)
        per_sym = {}
        for sym in SYMBOLS:
            lev = min(lev_req, MAX_LEV[sym])
            d = data[sym]
            margin = NEW_MARGIN_FRACTION * NEW_WALLET
            notional = margin * lev
            print(f"\n  === {sym} @ {lev}x   margin=${margin:.0f}   notional=${notional:.0f} ===")

            rl = base.simulate_bot(d["candles"], "long", lev, d["tick"])
            rs = base.simulate_bot(d["candles"], "short", lev, d["tick"])
            sl = base.summarize(rl, f"{sym} LONG @ {lev}x")
            ss = base.summarize(rs, f"{sym} SHORT @ {lev}x")
            print_wallet(sl, f"--- LONG bot ({sym}) ---")
            print_wallet(ss, f"--- SHORT bot ({sym}) ---")

            combined_net = sl["net"] + ss["net"]
            sym_capital = 2 * NEW_WALLET   # $2,000 for the two wallets on this symbol
            pct = combined_net / sym_capital * 100
            curve, events = build_equity_curve(rl["trades"], rs["trades"],
                                               d["first_ts"], d["last_ts"])
            mdd, peak_ts, trough_ts = max_drawdown(curve)
            print(f"\n    ~~ {sym} COMBINED @ {lev}x (on ${sym_capital:.0f}) ~~")
            print(f"      NET ${combined_net:+.2f}   return {pct:+.1f}%   MDD ${mdd:.2f} ({mdd/sym_capital*100:.1f}%)")
            print(f"      total trades: {sl['n']+ss['n']}   wins: {sl['wins']+ss['wins']}   stops+floors: {sl['stops']+ss['stops']+sl['floors']+ss['floors']}")

            per_sym[sym] = {
                "lev": lev, "long": sl, "short": ss, "net": combined_net,
                "pct": pct, "mdd": mdd,
                "trades_long": rl["trades"], "trades_short": rs["trades"],
                "first_ts": d["first_ts"], "last_ts": d["last_ts"],
            }

        # portfolio-level: aggregate equity curves across all 6 wallets
        all_trades = []
        first_ts_all = min(p["first_ts"] for p in per_sym.values())
        last_ts_all = max(p["last_ts"] for p in per_sym.values())
        for p in per_sym.values():
            all_trades += p["trades_long"] + p["trades_short"]
        p_curve, p_events = build_equity_curve(all_trades, [], first_ts_all, last_ts_all)
        p_mdd, _, _ = max_drawdown(p_curve)
        p_net = sum(p["net"] for p in per_sym.values())
        p_pct = p_net / (6 * NEW_WALLET) * 100

        print("\n" + "-" * 100)
        print(f"  PORTFOLIO @ {lev_req}x (6 wallets, ${6*NEW_WALLET:.0f})")
        print("-" * 100)
        print(f"    per-symbol NET:")
        for sym in SYMBOLS:
            p = per_sym[sym]
            mark = "✓" if p["net"] > 0 else "✗"
            print(f"      {mark} {sym} @ {p['lev']}x  ${p['net']:>+10.2f}  ({p['pct']:>+6.1f}%)   MDD ${p['mdd']:.2f}")
        print(f"    TOTAL NET ${p_net:+.2f}   return {p_pct:+.1f}%   combined MDD ${p_mdd:.2f} ({p_mdd/(6*NEW_WALLET)*100:.1f}%)")

        portfolio_by_lev[lev_req] = {"per_sym": per_sym, "net": p_net,
                                      "pct": p_pct, "mdd": p_mdd}

    # ---- summary table ----
    print("\n" + "=" * 100)
    print("SUMMARY — leverage sweep")
    print("=" * 100)
    print(f"  {'lev':>4}  {'BTC net':>10}  {'ETH net':>10}  {'SOL net':>10}  {'TOTAL':>10}  {'return':>7}  {'port MDD':>10}")
    for lev, r in portfolio_by_lev.items():
        btc = r["per_sym"]["BTC-USDT"]["net"]
        eth = r["per_sym"]["ETH-USDT"]["net"]
        sol = r["per_sym"]["SOL-USDT"]["net"]
        print(f"  {lev:>3}x  ${btc:>+9.2f}  ${eth:>+9.2f}  ${sol:>+9.2f}  ${r['net']:>+9.2f}  {r['pct']:>+6.1f}%  ${r['mdd']:>9.2f}")

    # ---- plain assessment ----
    print("\n" + "=" * 100)
    print("PLAIN ASSESSMENT")
    print("=" * 100)
    best_lev = max(portfolio_by_lev, key=lambda k: portfolio_by_lev[k]["net"])
    r25 = portfolio_by_lev[25]
    print(f"* Baseline 25x per-symbol (on $2,000 each):")
    for sym in SYMBOLS:
        p = r25["per_sym"][sym]
        verdict = "PROFITABLE" if p["net"] > 0 else "LOST MONEY"
        print(f"    - {sym}: {verdict}  ${p['net']:+.2f} ({p['pct']:+.1f}%)  MDD ${p['mdd']:.2f}  "
              f"W/L L={p['long']['ratio']:.2f} S={p['short']['ratio']:.2f}  "
              f"wins% L={p['long']['win_rate']:.0f} S={p['short']['win_rate']:.0f}")
    winners = [s for s in SYMBOLS if r25["per_sym"][s]["net"] > 0]
    losers = [s for s in SYMBOLS if r25["per_sym"][s]["net"] <= 0]
    print(f"* At 25x: winners = {winners or 'NONE'}   losers = {losers or 'NONE'}")
    print(f"* Best portfolio leverage: {best_lev}x → NET ${portfolio_by_lev[best_lev]['net']:+.2f} ({portfolio_by_lev[best_lev]['pct']:+.1f}%) on $6,000, MDD ${portfolio_by_lev[best_lev]['mdd']:.2f}")
    # generalization
    btc25 = r25["per_sym"]["BTC-USDT"]["net"]
    eth25 = r25["per_sym"]["ETH-USDT"]["net"]
    sol25 = r25["per_sym"]["SOL-USDT"]["net"]
    if btc25 > 0 and eth25 > 0 and sol25 > 0:
        gen = "GENERALIZES across all 3 symbols"
    elif btc25 > 0 and eth25 > 0 and sol25 <= 0:
        gen = "generalizes to ETH but SOL bleeds — 2-of-3"
    elif btc25 > 0 and eth25 <= 0 and sol25 <= 0:
        gen = "BTC-ONLY edge — does NOT generalize"
    else:
        gen = "mixed / inconsistent"
    print(f"* Generalization: {gen}")


if __name__ == "__main__":
    main()
