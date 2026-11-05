"""FULL-SCALE CROSS-MARGIN PORTFOLIO BACKTEST — 10 symbols, funding modeled.

Extends backtest_pnl_crossmargin_portfolio.py:
  * Symbol universe: BTC, ETH, SOL, XRP, APEX, PENGU, DOGE, SUI, AVAX, LINK
    (verified per-symbol at fetch; any that don't resolve are skipped &
    reported honestly — no fabrication).
  * Two pool sizes run back-to-back for comparison:
      - $12,000  (proportional to 20 wallets × $600)
      - $3,600   (strain check — smaller pool, ~20 concurrent positions)
  * FUNDING modeled: ApeX charges funding HOURLY on perps. We apply
    HOURLY_FUNDING_RATE per hour to each open position's notional.
    Direction convention: longs PAY when funding > 0, shorts RECEIVE.
    We assume a NET funding of +0.00125%/hr (≈ +0.01%/8h) as a drag on
    longs, credit to shorts — stated as an ASSUMPTION (real per-symbol
    historical rates not available in this sandbox).
  * Peak concurrent-position tracking.
  * Live engine/signal files unchanged.
"""
from __future__ import annotations

import traceback
from dataclasses import dataclass
from typing import Optional

import hunter_signal as hs
from backtest_pnl_1yr import fetch_max_history
from backtest_pnl_crossmargin_portfolio import (
    Plan, OpenPos, ClosedTrade, unrealized,
    plan_accumulator, plan_hunter, fmt_ts,
    LEVERAGE, MARGIN_PER_TRADE, NOTIONAL_PER_TRADE, MMR, HUNTER_K, HOURS, EMA_LEN,
)
from backtest_pnl_limit_tp import apply_slip, FEE_RATE

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

SYMBOLS_REQUESTED = [
    "BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "APEX-USDT",
    "PENGU-USDT", "DOGE-USDT", "SUI-USDT", "AVAX-USDT", "LINK-USDT",
]

POOL_SIZES = [12_000.0, 3_600.0]

# Funding assumption — see module docstring
HOURLY_FUNDING_RATE = 0.0000125   # 0.00125% per hour (≈ 0.01% per 8h)
FUNDING_INTERVAL_MS = 3_600_000    # hourly


def simulate(sym_candles: dict[str, list], plans: list[Plan],
             starting_balance: float, apply_funding: bool):
    """Cross-margin sim with optional hourly funding accrual.

    Returns dict with the same keys as the 6-symbol script PLUS
    'funding_total', 'peak_concurrent', 'funding_events'.
    """
    ts_set: set[int] = set()
    for c in sym_candles.values():
        for row in c:
            ts_set.add(int(row[TS]))
    all_ts = sorted(ts_set)

    sym_row: dict[str, dict[int, list]] = {s: {} for s in sym_candles}
    sym_idx: dict[str, dict[int, int]] = {s: {} for s in sym_candles}
    for s, c in sym_candles.items():
        for i, row in enumerate(c):
            t = int(row[TS])
            sym_row[s][t] = row
            sym_idx[s][t] = i

    entries_by: dict[tuple[str, int], list[Plan]] = {}
    for p in plans:
        entries_by.setdefault((p.symbol, p.entry_i), []).append(p)

    balance = starting_balance
    open_positions: dict[str, OpenPos] = {}
    closed: list[ClosedTrade] = []
    equity_curve: list[tuple[int, float]] = []
    peak_equity = balance
    max_dd = 0.0
    max_dd_ts = 0

    total_bars_with_open = 0
    bars_with_offset = 0
    bars_with_loser = 0

    liquidated = False
    liq_ts = None
    liq_open_count = 0

    funding_total = 0.0
    funding_events = 0
    peak_concurrent = 0
    last_funding_bucket = None

    for t in all_ts:
        if liquidated:
            break

        # EXITS
        for slot, pos in list(open_positions.items()):
            sym = pos.plan.symbol
            if t not in sym_row[sym]:
                continue
            i_here = sym_idx[sym][t]
            if i_here == pos.plan.exit_i:
                raw_exit = pos.plan.exit_px
                fill_exit = apply_slip(raw_exit, pos.plan.direction, is_entry=False)
                exit_fee = fill_exit * pos.qty * FEE_RATE
                exit_slip = abs(fill_exit - raw_exit) * pos.qty
                if pos.plan.direction == "long":
                    gross = (fill_exit - pos.fill_px) * pos.qty
                else:
                    gross = (pos.fill_px - fill_exit) * pos.qty
                fees = pos.entry_fee + exit_fee
                slip = pos.entry_slip_cost + exit_slip
                net = gross - fees - slip
                balance += pos.notional / LEVERAGE + net
                closed.append(ClosedTrade(
                    plan=pos.plan, fill_px=pos.fill_px, exit_price=fill_exit,
                    qty=pos.qty, notional=pos.notional,
                    fees=fees, slip_cost=slip, gross_pnl=gross, net_pnl=net,
                    opened_ts=pos.opened_ts, closed_ts=t,
                ))
                del open_positions[slot]

        # ENTRIES
        for sym in sym_candles:
            if t not in sym_row[sym]:
                continue
            i_here = sym_idx[sym][t]
            key = (sym, i_here)
            if key not in entries_by:
                continue
            for plan in entries_by[key]:
                if plan.slot in open_positions:
                    continue
                if balance < MARGIN_PER_TRADE:
                    continue
                raw_entry = plan.entry_px
                fill_entry = apply_slip(raw_entry, plan.direction, is_entry=True)
                qty = NOTIONAL_PER_TRADE / fill_entry
                entry_fee = fill_entry * qty * FEE_RATE
                entry_slip_cost = abs(fill_entry - raw_entry) * qty
                balance -= MARGIN_PER_TRADE
                open_positions[plan.slot] = OpenPos(
                    plan=plan, fill_px=fill_entry, qty=qty,
                    notional=NOTIONAL_PER_TRADE,
                    entry_fee=entry_fee, entry_slip_cost=entry_slip_cost,
                    opened_ts=t,
                )

        # FUNDING — accrue hourly on notional of each open position
        if apply_funding and open_positions:
            bucket = t // FUNDING_INTERVAL_MS
            if last_funding_bucket is None:
                last_funding_bucket = bucket
            elif bucket > last_funding_bucket:
                hours_elapsed = bucket - last_funding_bucket
                last_funding_bucket = bucket
                for slot, pos in open_positions.items():
                    # long PAYS positive funding (drag), short RECEIVES (credit)
                    sign = -1.0 if pos.plan.direction == "long" else +1.0
                    delta = sign * HOURLY_FUNDING_RATE * pos.notional * hours_elapsed
                    balance += delta
                    funding_total += delta
                    funding_events += 1
        elif not open_positions:
            last_funding_bucket = None

        # MARK-TO-MARKET
        equity_open = 0.0
        margin_locked = 0.0
        notional_open = 0.0
        winner_count = 0; loser_count = 0
        for slot, pos in open_positions.items():
            sym = pos.plan.symbol
            row = sym_row[sym].get(t)
            mark = float(row[CLOSE]) if row is not None else pos.fill_px
            u = unrealized(pos, mark)
            equity_open += u
            margin_locked += MARGIN_PER_TRADE
            notional_open += pos.notional
            if u > 0: winner_count += 1
            elif u < 0: loser_count += 1

        equity = balance + margin_locked + equity_open
        if equity > peak_equity:
            peak_equity = equity
        dd = peak_equity - equity
        if dd > max_dd:
            max_dd = dd; max_dd_ts = t
        equity_curve.append((t, equity))

        if open_positions:
            total_bars_with_open += 1
            if loser_count > 0:
                bars_with_loser += 1
                if winner_count > 0:
                    bars_with_offset += 1
            if len(open_positions) > peak_concurrent:
                peak_concurrent = len(open_positions)

        # LIQUIDATION
        maint_req = MMR * notional_open
        if notional_open > 0 and equity < maint_req:
            liquidated = True
            liq_ts = t
            liq_open_count = len(open_positions)
            for slot, pos in list(open_positions.items()):
                sym = pos.plan.symbol
                row = sym_row[sym].get(t)
                mark = float(row[CLOSE]) if row is not None else pos.fill_px
                fill_exit = apply_slip(mark, pos.plan.direction, is_entry=False)
                exit_fee = fill_exit * pos.qty * FEE_RATE
                exit_slip = abs(fill_exit - mark) * pos.qty
                if pos.plan.direction == "long":
                    gross = (fill_exit - pos.fill_px) * pos.qty
                else:
                    gross = (pos.fill_px - fill_exit) * pos.qty
                fees = pos.entry_fee + exit_fee
                slip = pos.entry_slip_cost + exit_slip
                net = gross - fees - slip
                balance += pos.notional / LEVERAGE + net
                closed.append(ClosedTrade(
                    plan=pos.plan, fill_px=pos.fill_px, exit_price=fill_exit,
                    qty=pos.qty, notional=pos.notional,
                    fees=fees, slip_cost=slip, gross_pnl=gross, net_pnl=net,
                    opened_ts=pos.opened_ts, closed_ts=t, forced_liq=True,
                ))
            open_positions.clear()

    # close any remaining at last ts
    if all_ts:
        last_ts = all_ts[-1]
        for slot, pos in list(open_positions.items()):
            sym = pos.plan.symbol
            row = sym_row[sym].get(last_ts)
            mark = float(row[CLOSE]) if row is not None else pos.fill_px
            fill_exit = apply_slip(mark, pos.plan.direction, is_entry=False)
            exit_fee = fill_exit * pos.qty * FEE_RATE
            exit_slip = abs(fill_exit - mark) * pos.qty
            if pos.plan.direction == "long":
                gross = (fill_exit - pos.fill_px) * pos.qty
            else:
                gross = (pos.fill_px - fill_exit) * pos.qty
            fees = pos.entry_fee + exit_fee
            slip = pos.entry_slip_cost + exit_slip
            net = gross - fees - slip
            balance += pos.notional / LEVERAGE + net
            closed.append(ClosedTrade(
                plan=pos.plan, fill_px=pos.fill_px, exit_price=fill_exit,
                qty=pos.qty, notional=pos.notional,
                fees=fees, slip_cost=slip, gross_pnl=gross, net_pnl=net,
                opened_ts=pos.opened_ts, closed_ts=last_ts,
            ))
        open_positions.clear()

    return {
        "closed": closed,
        "final_balance": balance,
        "final_equity": balance,
        "equity_curve": equity_curve,
        "peak_equity": peak_equity,
        "max_dd": max_dd,
        "max_dd_ts": max_dd_ts,
        "liquidated": liquidated,
        "liq_ts": liq_ts,
        "liq_open_count": liq_open_count,
        "bars_open": total_bars_with_open,
        "bars_offset": bars_with_offset,
        "bars_loser": bars_with_loser,
        "funding_total": funding_total,
        "funding_events": funding_events,
        "peak_concurrent": peak_concurrent,
    }


def report(result: dict, first_ts: int, last_ts: int, pool: float,
           label: str, symbols: list[str]):
    closed = result["closed"]
    net = sum(t.net_pnl for t in closed)
    gross = sum(t.gross_pnl for t in closed)
    fees = sum(t.fees for t in closed)
    slip = sum(t.slip_cost for t in closed)
    wins = [t for t in closed if t.net_pnl > 0]
    losses = [t for t in closed if t.net_pnl <= 0]
    wr = len(wins) / len(closed) * 100 if closed else 0.0

    print("\n" + "=" * 100)
    print(f"CROSS-MARGIN PORTFOLIO — {label}  (pool ${pool:,.0f})")
    print("=" * 100)
    span_d = (last_ts - first_ts) / 86_400_000
    print(f"span: {fmt_ts(first_ts)}  →  {fmt_ts(last_ts)}   ({span_d:.1f} days)")
    print(f"starting balance: ${pool:,.2f}")
    print(f"final equity:     ${result['final_equity']:,.2f}")
    print(f"NET P&L:          ${net:+,.2f}   ({net/pool*100:+.1f}%)")
    print(f"  gross ${gross:+,.2f}   fees ${fees:.2f}   slip ${slip:.2f}"
          f"   funding ${result['funding_total']:+,.2f}  ({result['funding_events']} accruals)")
    print(f"trades: {len(closed)}  wins: {len(wins)}  losses: {len(losses)}  win rate: {wr:.1f}%")
    print(f"peak equity ${result['peak_equity']:,.2f}   MAX DD ${result['max_dd']:,.2f}"
          f"  ({result['max_dd']/pool*100:.1f}% of pool)"
          f"   at {fmt_ts(result['max_dd_ts']) if result['max_dd_ts'] else 'n/a'}")
    print(f"peak concurrent open positions: {result['peak_concurrent']}")
    if result["liquidated"]:
        print(f"⚠ ACCOUNT LIQUIDATED at {fmt_ts(result['liq_ts'])} — "
              f"{result['liq_open_count']} open positions force-closed.")
    else:
        print("✓ account survived — never breached maintenance margin.")

    if result["bars_open"]:
        off_pct = result["bars_offset"] / result["bars_open"] * 100
        lose_pct = result["bars_loser"] / result["bars_open"] * 100
        off_of_loser = (result["bars_offset"] / result["bars_loser"] * 100
                        if result["bars_loser"] else 0.0)
    else:
        off_pct = lose_pct = off_of_loser = 0.0
    print("\nOFFSETTING")
    print(f"  bars with ≥1 open pos:            {result['bars_open']:,}")
    print(f"  bars with ≥1 losing pos open:     {result['bars_loser']:,}  ({lose_pct:.1f}% of open bars)")
    print(f"  bars where winner cushioned loser: {result['bars_offset']:,}"
          f"  ({off_pct:.1f}% of open bars,  {off_of_loser:.1f}% of loser-bars)")

    print("\nPER-STRATEGY CONTRIBUTION")
    for strat in ("accum", "hunter"):
        ts = [t for t in closed if t.plan.strategy == strat]
        if not ts:
            print(f"  {strat:6s}: no trades"); continue
        n = len(ts); n_w = sum(1 for t in ts if t.net_pnl > 0)
        s_net = sum(t.net_pnl for t in ts)
        print(f"  {strat:6s}: trades={n:4d}  wins={n_w:4d}  win%={n_w/n*100:5.1f}%  NET ${s_net:+,.2f}")

    print("\nPER-SYMBOL CONTRIBUTION")
    for sym in symbols:
        ts = [t for t in closed if t.plan.symbol == sym]
        if not ts:
            continue
        s_net = sum(t.net_pnl for t in ts)
        n_w = sum(1 for t in ts if t.net_pnl > 0)
        print(f"  {sym:11s}: trades={len(ts):3d}  wins={n_w:3d}  NET ${s_net:+,.2f}")


def main():
    print("=" * 100)
    print("FULL-SCALE CROSS-MARGIN PORTFOLIO — 10 symbols, funding modeled")
    print(f"  requested symbols: {SYMBOLS_REQUESTED}")
    print(f"  leverage {LEVERAGE}x   flat margin ${MARGIN_PER_TRADE}/trade   "
          f"notional ${NOTIONAL_PER_TRADE}   MMR {MMR*100:.2f}%")
    print(f"  strategies: Accumulator (100-EMA trend-filtered, L+S) + Hunter (K={HUNTER_K}, both variants)")
    print(f"  costs: taker 5bps + slip 2bps per fill")
    print(f"  FUNDING: hourly accrual at {HOURLY_FUNDING_RATE*100:.5f}%/hr on notional")
    print(f"           (assumption ≈ +0.01% per 8h — longs pay, shorts receive; ")
    print(f"           real per-symbol historical funding not available in this run)")
    print(f"  pool sizes: {POOL_SIZES}   |   window: last {HOURS//24} days of ApeX 5m klines")
    print("=" * 100)

    sym_candles: dict[str, list] = {}
    ticks: dict[str, float] = {}
    resolved: list[str] = []
    skipped: list[tuple[str, str]] = []
    first_ts_all = None; last_ts_all = None

    for sym in SYMBOLS_REQUESTED:
        try:
            print(f"\nfetching {sym} …")
            candles, tick, first_ts, last_ts = fetch_max_history(sym, 5, HOURS)
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"
            print(f"  !!! FETCH FAILED for {sym}: {msg}")
            skipped.append((sym, msg))
            continue
        if not candles:
            skipped.append((sym, "no candles returned"))
            continue
        span_ms = HOURS * 3_600_000
        cutoff = int(candles[-1][TS]) - span_ms
        candles = [c for c in candles if int(c[TS]) >= cutoff]
        first_ts = int(candles[0][TS]); last_ts = int(candles[-1][TS])
        print(f"  {sym}: {len(candles):,} candles  span "
              f"{fmt_ts(first_ts)} → {fmt_ts(last_ts)}  "
              f"({(last_ts-first_ts)/86_400_000:.1f}d)")
        sym_candles[sym] = candles
        ticks[sym] = tick
        resolved.append(sym)
        first_ts_all = first_ts if first_ts_all is None else min(first_ts_all, first_ts)
        last_ts_all = last_ts if last_ts_all is None else max(last_ts_all, last_ts)

    print("\n" + "-" * 100)
    print(f"RESOLVED ({len(resolved)}): {resolved}")
    if skipped:
        print(f"SKIPPED  ({len(skipped)}):")
        for s, m in skipped:
            print(f"  - {s}: {m}")
    else:
        print("SKIPPED: none")
    print("-" * 100)

    if not resolved:
        print("no symbols resolved — cannot backtest.")
        return

    print("\nplanning trades per strategy/symbol …")
    plans: list[Plan] = []
    for sym in resolved:
        a = plan_accumulator(sym_candles[sym], ticks[sym], sym)
        h = plan_hunter(sym_candles[sym], sym)
        print(f"  {sym:11s}: accum plans={len(a):3d}   hunter plans={len(h):3d}")
        plans.extend(a); plans.extend(h)
    print(f"total planned trades across the fleet: {len(plans)}")

    # Run all four combinations: {12k, 3.6k} x {no-funding, funding}
    for pool in POOL_SIZES:
        # NO FUNDING baseline (for delta reporting)
        r_no = simulate(sym_candles, plans, pool, apply_funding=False)
        # WITH FUNDING (headline)
        r_yes = simulate(sym_candles, plans, pool, apply_funding=True)

        net_no = sum(t.net_pnl for t in r_no["closed"])
        net_yes = sum(t.net_pnl for t in r_yes["closed"])
        drag = net_yes - net_no

        report(r_yes, first_ts_all, last_ts_all, pool,
               label=f"WITH FUNDING", symbols=resolved)
        print(f"\nFUNDING DRAG vs no-funding: net delta ${drag:+,.2f}  "
              f"(no-funding NET ${net_no:+,.2f} → with-funding NET ${net_yes:+,.2f})")

    print("\n" + "=" * 100)
    print("END OF FULL-SCALE RUN — HONEST CAVEATS")
    print("=" * 100)
    print("  * Funding rate is an ASSUMPTION (~0.01%/8h). Real per-symbol historical")
    print("    funding on ApeX will vary — heavy directional bias can move NET by a")
    print("    few % either way. Trend-following legs (e.g. persistent long uptrends)")
    print("    typically pay funding; contrarian shorts in those windows receive it.")
    print("  * 90 days = one window (sketch, not proof).")
    print("  * MMR held constant at 0.5% (ApeX tier-1 majors); tier steps up for")
    print("    larger notional — we're under those thresholds at $60 margin/trade.")


if __name__ == "__main__":
    main()
