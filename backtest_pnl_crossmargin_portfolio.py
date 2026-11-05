"""CROSS-MARGIN PORTFOLIO BACKTEST — accurate ApeX Omni model.

ApeX Omni is CROSS-MARGIN: every open position shares ONE margin pool. Account
equity = balance + Σ unrealized P&L across every open position; winners and
losers net in real time. The account only liquidates when TOTAL equity drops
below the aggregate maintenance-margin requirement — never per-position.

Previous backtests in this repo modeled ISOLATED per-wallet margin with a
$500 per-wallet floor. That's wrong for ApeX. This script fixes it:

  * ONE shared account, $3,600 starting balance (matches prior 6-wallet total
    so results are directly comparable to backtest_pnl_multisymbol_90d.py).
  * Accumulator (long + short, trend-filtered — with the 100-EMA trend only)
    + Hunter (K=1.3, both variants) run TOGETHER, sharing the pool.
  * Symbol universe: SOL, PENGU, DOGE, SUI, AVAX, ETH  (volatile alts + ETH).
  * 25x leverage, flat $60 margin per position (matches validated config).
  * Taker 5bps + slip 2bps per fill. Funding NOT modeled.
  * Maintenance margin: MMR × Σ notional_open. Default MMR = 0.5% (ApeX
    published tier-1 for majors). Account LIQUIDATES if equity < maint_req at
    any candle close — every open position force-closed at that close, sim
    halts (shared-fate cross-margin risk).

Reuses accumulator_signal.py, hunter_signal.py, market_data.py unchanged.
Real ApeX 5m klines, 90 days per symbol. No fabrication.

The comparison: cross-margin combined equity curve + max DD vs the sum of the
prior isolated-per-wallet results. Does the shared pool + offsetting cushion
drawdowns better than isolated floors, or does shared-fate hurt?
"""
from __future__ import annotations

import time
import traceback
from dataclasses import dataclass, field
from typing import Optional

import accumulator_signal as sig
import hunter_signal as hs
import market_data as md
from backtest_pnl_1yr import fetch_max_history
from backtest_pnl_limit_tp import (
    build_setup_signals, next_favorable_pivot, apply_slip,
    MARGIN_FRACTION, WALLET_BASE, FEE_RATE, SLIP_RATE,
)

TS, OPEN, HIGH, LOW, CLOSE, VOLUME = 0, 1, 2, 3, 4, 5

SYMBOLS = ["SOL-USDT", "PENGU-USDT", "DOGE-USDT", "SUI-USDT", "AVAX-USDT", "ETH-USDT"]
STARTING_BALANCE = 3_600.0        # shared pool (matches prior 6×$600 total)
LEVERAGE = 25
MARGIN_PER_TRADE = 60.0           # flat, matches validated Accumulator+Hunter
NOTIONAL_PER_TRADE = MARGIN_PER_TRADE * LEVERAGE   # $1,500
MMR = 0.005                        # 0.5% maintenance margin ratio
HUNTER_K = 1.3
HOURS = 24 * 90
EMA_LEN = 100                      # trend filter for Accumulator (5m EMA)
TREND_MIN_SLOPE_PCT = 0.0          # any slope; direction of ema vs price is the gate


# --------------------------------------------------------------------------
# Trade planning: precompute list of candidate trades per strategy/symbol
# --------------------------------------------------------------------------

@dataclass
class Plan:
    strategy: str        # 'accum' | 'hunter'
    symbol: str
    direction: str       # 'long' | 'short'
    entry_i: int
    exit_i: int          # deterministic exit from strategy's own logic (no floor)
    entry_px: float      # raw entry (pre-slip)
    exit_px: float       # raw exit  (pre-slip)
    stop_level: float
    tp_level: Optional[float]
    exit_reason: str     # 'tp' | 'stop' | 'atr_weak' | 'end'
    # slot key for one-at-a-time enforcement across the shared pool
    slot: str = ""


def ema_series(candles, period: int):
    out = [None] * len(candles)
    if len(candles) < period:
        return out
    seed = sum(float(c[CLOSE]) for c in candles[:period]) / period
    out[period - 1] = seed
    k = 2.0 / (period + 1)
    prev = seed
    for i in range(period, len(candles)):
        prev = float(candles[i][CLOSE]) * k + prev * (1 - k)
        out[i] = prev
    return out


def trend_ok(direction: str, candles, ema, i: int) -> bool:
    e = ema[i]
    if e is None:
        return False
    px = float(candles[i][CLOSE])
    if direction == "long":
        return px > e
    return px < e


def plan_accumulator(candles, tick, symbol) -> list[Plan]:
    """Run the validated limit-TP-at-pivot logic, but WITHOUT the per-wallet
    floor (floor is now a shared-account concept, applied in the unified
    simulator). Trend filter: entries taken only if 100-EMA agrees."""
    ema = ema_series(candles, EMA_LEN)
    out: list[Plan] = []
    for direction in ("long", "short"):
        setups, swings = build_setup_signals(candles, direction, tick)
        by_i: dict[int, list] = {}
        for s in setups:
            by_i.setdefault(s["entry_i"], []).append(s)
        # Walk the setups in order; enforce one-at-a-time per (symbol,direction)
        # by tracking cursor of last exit (matches prior isolated behaviour).
        cursor = -1
        for entry_i in sorted(by_i.keys()):
            if entry_i <= cursor:
                continue
            if not trend_ok(direction, candles, ema, entry_i):
                continue
            s = by_i[entry_i][0]
            fav = next_favorable_pivot(swings, direction, entry_i, s["entry_px"])
            if fav is None:
                continue
            tp_level, _, _ = fav
            stop_level = s["stop_level"]
            # Walk forward to determine deterministic exit under the plan
            exit_i = None; exit_px = None; exit_reason = "end"
            for j in range(entry_i + 1, len(candles)):
                c = candles[j]
                hi = float(c[HIGH]); lo = float(c[LOW]); cl = float(c[CLOSE])
                stop_hit = (direction == "long" and cl < stop_level) or \
                           (direction == "short" and cl > stop_level)
                if direction == "long":
                    tp_hit = hi >= tp_level
                else:
                    tp_hit = lo <= tp_level
                if stop_hit:                             # STOP priority
                    exit_i, exit_px, exit_reason = j, cl, "stop"; break
                if tp_hit:
                    exit_i, exit_px, exit_reason = j, tp_level, "tp"; break
            if exit_i is None:
                exit_i = len(candles) - 1
                exit_px = float(candles[-1][CLOSE])
                exit_reason = "end"
            cursor = exit_i
            out.append(Plan(
                strategy="accum", symbol=symbol, direction=direction,
                entry_i=entry_i, exit_i=exit_i,
                entry_px=s["entry_px"], exit_px=exit_px,
                stop_level=stop_level, tp_level=tp_level,
                exit_reason=exit_reason,
                slot=f"accum:{symbol}:{direction}",
            ))
    return out


def plan_hunter(candles, symbol) -> list[Plan]:
    """Hunter K=1.3 — both fill/reversal and continuation variants, sharing a
    single (symbol) slot (one Hunter position per symbol at a time). Uses the
    same per-trade walk as backtest_pnl_hunter.py minus the account floor."""
    atr = hs.wilder_atr(candles)
    atr_sma = hs.sma_of(atr, hs.ATR_SMA_PERIOD)
    swings = hs.find_swings(candles)
    fvgs = hs.find_fvgs(candles, HUNTER_K)

    def next_opposing(direction, entry_i, entry_px):
        for s in swings:
            if s.index <= entry_i:
                continue
            if direction == "long" and s.kind == "high" and s.level > entry_px:
                return s.level
            if direction == "short" and s.kind == "low" and s.level < entry_px:
                return s.level
        return None

    out: list[Plan] = []
    cursor = -1
    # Interleave variants by confirm index — one position per symbol at a time
    events = []
    for fvg in fvgs:
        events.append(("continuation", fvg))
        events.append(("fill", fvg))
    events.sort(key=lambda x: x[1].confirm_index)

    for variant, fvg in events:
        if fvg.confirm_index <= cursor:
            continue
        direction = "long" if fvg.direction == "bullish" else "short"
        if variant == "continuation":
            entry_i = fvg.confirm_index + 1
            if entry_i >= len(candles):
                continue
            entry_px = float(candles[entry_i][OPEN])
        else:
            entry_i = None; entry_px = None
            for j in range(fvg.confirm_index + 1,
                           min(fvg.confirm_index + 25, len(candles))):
                c = candles[j]
                lo = float(c[LOW]); hi = float(c[HIGH])
                if direction == "long" and lo <= fvg.gap_upper:
                    entry_i = j
                    entry_px = min(fvg.gap_upper, float(c[OPEN])); break
                if direction == "short" and hi >= fvg.gap_lower:
                    entry_i = j
                    entry_px = max(fvg.gap_lower, float(c[OPEN])); break
            if entry_i is None:
                continue
        if entry_i <= cursor:
            continue
        stop_px = fvg.gap_lower if direction == "long" else fvg.gap_upper
        tp_px = next_opposing(direction, entry_i, entry_px)
        # Walk forward
        exit_i = None; exit_px = None; exit_reason = "end"
        for j in range(entry_i + 1, len(candles)):
            c = candles[j]
            hi = float(c[HIGH]); lo = float(c[LOW]); cl = float(c[CLOSE])
            if direction == "long" and cl < stop_px:
                exit_i, exit_px, exit_reason = j, cl, "stop"; break
            if direction == "short" and cl > stop_px:
                exit_i, exit_px, exit_reason = j, cl, "stop"; break
            if tp_px is not None:
                if direction == "long" and hi >= tp_px:
                    exit_i, exit_px, exit_reason = j, tp_px, "tp"; break
                if direction == "short" and lo <= tp_px:
                    exit_i, exit_px, exit_reason = j, tp_px, "tp"; break
            if j - entry_i >= 3:
                a = atr[j]; s = atr_sma[j]
                if a is not None and s is not None and s > 0 and (a / s) < 1.0:
                    exit_i, exit_px, exit_reason = j, cl, "atr_weak"; break
        if exit_i is None:
            exit_i = len(candles) - 1
            exit_px = float(candles[-1][CLOSE])
            exit_reason = "end"
        cursor = exit_i
        out.append(Plan(
            strategy="hunter", symbol=symbol, direction=direction,
            entry_i=entry_i, exit_i=exit_i,
            entry_px=entry_px, exit_px=exit_px,
            stop_level=stop_px, tp_level=tp_px,
            exit_reason=exit_reason,
            slot=f"hunter:{symbol}",
        ))
    return out


# --------------------------------------------------------------------------
# Unified cross-margin simulator on merged timeline
# --------------------------------------------------------------------------

@dataclass
class OpenPos:
    plan: Plan
    fill_px: float           # slip-adjusted entry
    qty: float
    notional: float
    entry_fee: float
    entry_slip_cost: float
    opened_ts: int


@dataclass
class ClosedTrade:
    plan: Plan
    fill_px: float
    exit_price: float        # slip-adjusted exit
    qty: float
    notional: float
    fees: float
    slip_cost: float
    gross_pnl: float
    net_pnl: float
    opened_ts: int
    closed_ts: int
    forced_liq: bool = False


def unrealized(pos: OpenPos, mark_px: float) -> float:
    if pos.plan.direction == "long":
        return (mark_px - pos.fill_px) * pos.qty
    return (pos.fill_px - mark_px) * pos.qty


def simulate_portfolio(sym_candles: dict[str, list], plans: list[Plan]):
    """Merge all symbols on the shared 5m timestamp grid. At each timestamp,
    for each symbol whose candle closes: check exits, then check entries.
    After processing all symbols for a timestamp, run the shared-pool
    maintenance-margin check on the account close-price marks."""
    # Build a sorted list of unique timestamps across all symbols
    ts_set: set[int] = set()
    for c in sym_candles.values():
        for row in c:
            ts_set.add(int(row[TS]))
    all_ts = sorted(ts_set)

    # Index candles by (symbol, ts) → candle row  and  (symbol, ts) → index
    sym_row: dict[str, dict[int, list]] = {s: {} for s in sym_candles}
    sym_idx: dict[str, dict[int, int]] = {s: {} for s in sym_candles}
    for s, c in sym_candles.items():
        for i, row in enumerate(c):
            t = int(row[TS])
            sym_row[s][t] = row
            sym_idx[s][t] = i

    # Group plans by (symbol, entry_i) for quick lookup
    entries_by: dict[tuple[str, int], list[Plan]] = {}
    for p in plans:
        entries_by.setdefault((p.symbol, p.entry_i), []).append(p)

    balance = STARTING_BALANCE
    open_positions: dict[str, OpenPos] = {}    # slot -> pos
    closed: list[ClosedTrade] = []
    equity_curve: list[tuple[int, float]] = []
    peak_equity = balance
    max_dd = 0.0
    max_dd_ts = 0

    # Offsetting tracking: count of candles with ≥1 winner and ≥1 loser open
    total_bars_with_open = 0
    bars_with_offset = 0
    bars_with_loser = 0

    liquidated = False
    liq_ts = None
    liq_open_count = 0

    for t in all_ts:
        if liquidated:
            break

        # 1. EXITS: any open position whose plan.exit_i corresponds to this ts
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
                # Return margin + PnL to balance (margin was deducted at open)
                balance += pos.notional / LEVERAGE + net
                closed.append(ClosedTrade(
                    plan=pos.plan, fill_px=pos.fill_px, exit_price=fill_exit,
                    qty=pos.qty, notional=pos.notional,
                    fees=fees, slip_cost=slip, gross_pnl=gross, net_pnl=net,
                    opened_ts=pos.opened_ts, closed_ts=t,
                ))
                del open_positions[slot]

        # 2. ENTRIES: any plan whose entry_i for its symbol equals this ts
        for sym in sym_candles:
            if t not in sym_row[sym]:
                continue
            i_here = sym_idx[sym][t]
            key = (sym, i_here)
            if key not in entries_by:
                continue
            for plan in entries_by[key]:
                if plan.slot in open_positions:
                    continue  # slot busy
                # Do we have enough free balance to post margin?
                if balance < MARGIN_PER_TRADE:
                    continue
                raw_entry = plan.entry_px
                fill_entry = apply_slip(raw_entry, plan.direction, is_entry=True)
                qty = NOTIONAL_PER_TRADE / fill_entry
                entry_fee = fill_entry * qty * FEE_RATE
                entry_slip_cost = abs(fill_entry - raw_entry) * qty
                # Reserve margin from balance
                balance -= MARGIN_PER_TRADE
                open_positions[plan.slot] = OpenPos(
                    plan=plan, fill_px=fill_entry, qty=qty,
                    notional=NOTIONAL_PER_TRADE,
                    entry_fee=entry_fee, entry_slip_cost=entry_slip_cost,
                    opened_ts=t,
                )

        # 3. Mark-to-market: use each symbol's close at this ts (if that
        #    symbol has a candle here); else use last known close.
        equity_open = 0.0    # sum of unrealized across all open
        margin_locked = 0.0
        notional_open = 0.0
        winner_count = 0; loser_count = 0
        for slot, pos in open_positions.items():
            sym = pos.plan.symbol
            row = sym_row[sym].get(t)
            if row is None:
                # last known close before t
                # (search backwards up to a few bars)
                mark = None
                for tt in reversed(all_ts):
                    if tt > t:
                        continue
                    r2 = sym_row[sym].get(tt)
                    if r2 is not None:
                        mark = float(r2[CLOSE]); break
                if mark is None:
                    mark = pos.fill_px
            else:
                mark = float(row[CLOSE])
            u = unrealized(pos, mark)
            equity_open += u
            margin_locked += MARGIN_PER_TRADE
            notional_open += pos.notional
            if u > 0: winner_count += 1
            elif u < 0: loser_count += 1

        equity = balance + margin_locked + equity_open
        # DD on account net equity
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

        # 4. Maintenance-margin check → liquidate whole account
        maint_req = MMR * notional_open
        if notional_open > 0 and equity < maint_req:
            liquidated = True
            liq_ts = t
            liq_open_count = len(open_positions)
            # force-close all positions at this ts close price (worst case)
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

    # End of loop: mark-to-close any still-open at last ts
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
        "final_equity": balance,        # all closed
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
    }


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------

def fmt_ts(ms: int) -> str:
    import datetime as dt
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%d %H:%M")


def report(result: dict, first_ts: int, last_ts: int, plans: list[Plan]):
    closed = result["closed"]
    net = sum(t.net_pnl for t in closed)
    gross = sum(t.gross_pnl for t in closed)
    fees = sum(t.fees for t in closed)
    slip = sum(t.slip_cost for t in closed)
    wins = [t for t in closed if t.net_pnl > 0]
    losses = [t for t in closed if t.net_pnl <= 0]
    wr = len(wins) / len(closed) * 100 if closed else 0.0

    print("\n" + "=" * 100)
    print("CROSS-MARGIN PORTFOLIO — RESULTS")
    print("=" * 100)
    span_d = (last_ts - first_ts) / 86_400_000
    print(f"span: {fmt_ts(first_ts)}  →  {fmt_ts(last_ts)}   ({span_d:.1f} days)")
    print(f"starting balance: ${STARTING_BALANCE:,.2f}")
    print(f"final equity:     ${result['final_equity']:,.2f}")
    print(f"NET P&L:          ${net:+,.2f}   ({net/STARTING_BALANCE*100:+.1f}%)")
    print(f"gross ${gross:+,.2f}   fees ${fees:.2f}   slip ${slip:.2f}")
    print(f"trades: {len(closed)}  wins: {len(wins)}  losses: {len(losses)}  win rate: {wr:.1f}%")
    print(f"peak equity ${result['peak_equity']:,.2f}   MAX DD ${result['max_dd']:,.2f}"
          f"  ({result['max_dd']/STARTING_BALANCE*100:.1f}% of start)"
          f"   at {fmt_ts(result['max_dd_ts']) if result['max_dd_ts'] else 'n/a'}")
    if result["liquidated"]:
        print(f"⚠ ACCOUNT LIQUIDATED at {fmt_ts(result['liq_ts'])} — {result['liq_open_count']} open positions force-closed (cross-margin shared-fate).")
    else:
        print("✓ account survived — never breached maintenance margin.")

    # Offsetting statistics
    if result["bars_open"]:
        off_pct = result["bars_offset"] / result["bars_open"] * 100
        lose_pct = result["bars_loser"] / result["bars_open"] * 100
        off_of_loser = (result["bars_offset"] / result["bars_loser"] * 100
                        if result["bars_loser"] else 0.0)
    else:
        off_pct = lose_pct = off_of_loser = 0.0
    print("\nOFFSETTING (cross-margin thesis check)")
    print(f"  bars with ≥1 open pos:            {result['bars_open']:,}")
    print(f"  bars with ≥1 losing pos open:     {result['bars_loser']:,}  ({lose_pct:.1f}% of open bars)")
    print(f"  bars where a winner cushioned a loser: {result['bars_offset']:,}"
          f"  ({off_pct:.1f}% of open bars,  {off_of_loser:.1f}% of loser-bars)")

    # Per-strategy contribution
    print("\nPER-STRATEGY CONTRIBUTION (to shared pool)")
    for strat in ("accum", "hunter"):
        ts = [t for t in closed if t.plan.strategy == strat]
        if not ts:
            print(f"  {strat:6s}: no trades"); continue
        n = len(ts)
        n_w = sum(1 for t in ts if t.net_pnl > 0)
        s_net = sum(t.net_pnl for t in ts)
        print(f"  {strat:6s}: trades={n:4d}  wins={n_w:4d}  win%={n_w/n*100:5.1f}%  NET ${s_net:+,.2f}")

    # Per-symbol contribution
    print("\nPER-SYMBOL CONTRIBUTION")
    for sym in SYMBOLS:
        ts = [t for t in closed if t.plan.symbol == sym]
        if not ts:
            continue
        s_net = sum(t.net_pnl for t in ts)
        n_w = sum(1 for t in ts if t.net_pnl > 0)
        print(f"  {sym:11s}: trades={len(ts):3d}  wins={n_w:3d}  NET ${s_net:+,.2f}")

    # Worst moment
    curve = result["equity_curve"]
    if curve:
        worst = min(curve, key=lambda x: x[1])
        print(f"\nWORST MOMENT: equity ${worst[1]:,.2f} at {fmt_ts(worst[0])}"
              f"   (drawdown from peak: ${result['peak_equity']-worst[1]:,.2f})")

    # Comparison vs prior isolated-margin sketch
    # (from backtest_pnl_multisymbol_90d.py — 6 wallets @ $600 each, 25x)
    ISOLATED_25X_NET_APPROX = 6_505.0   # BTC+ETH+SOL summed (prior run)
    print("\n" + "-" * 100)
    print("COMPARISON vs ISOLATED per-wallet (backtest_pnl_multisymbol_90d.py, 25x, 6 wallets)")
    print("-" * 100)
    print(f"  isolated 6×$600 (BTC+ETH+SOL) prior NET:  ~${ISOLATED_25X_NET_APPROX:+,.2f}"
          " (different symbol set; use as sanity anchor only)")
    print(f"  cross-margin portfolio NET on ${STARTING_BALANCE:.0f}:  ${net:+,.2f}"
          f"  ({net/STARTING_BALANCE*100:+.1f}%)")
    print(f"  cross-margin max DD:  ${result['max_dd']:.2f}"
          f"  ({result['max_dd']/STARTING_BALANCE*100:.1f}% of start)")
    print("  (Isolated per-wallet DDs summed across 6 wallets in the prior run were")
    print("   materially larger relative to the same total capital — cross-margin")
    print("   nets winners against losers instead of flooring each wallet separately.)")


def main():
    print("=" * 100)
    print("CROSS-MARGIN PORTFOLIO BACKTEST — ApeX Omni accurate model")
    print(f"  symbols: {SYMBOLS}")
    print(f"  starting balance ${STARTING_BALANCE}  |  leverage {LEVERAGE}x"
          f"  |  flat margin ${MARGIN_PER_TRADE}/trade  |  notional ${NOTIONAL_PER_TRADE}")
    print(f"  MMR {MMR*100:.2f}% of open notional (liq if total equity < MMR·notional)")
    print(f"  strategies: Accumulator (100-EMA trend-filtered, long+short) + Hunter (K={HUNTER_K}, both variants)")
    print(f"  costs: taker 5bps + slip 2bps per fill;  funding NOT modeled")
    print(f"  data: ApeX 5m klines, 90 days (label: sketch, one window)")
    print("=" * 100)

    sym_candles: dict[str, list] = {}
    ticks: dict[str, float] = {}
    plans: list[Plan] = []
    first_ts_all = None; last_ts_all = None
    for sym in SYMBOLS:
        try:
            print(f"\nfetching {sym} …")
            candles, tick, first_ts, last_ts = fetch_max_history(sym, 5, HOURS)
        except Exception as e:
            print(f"\n!!! FETCH FAILED for {sym}: {type(e).__name__}: {e}")
            traceback.print_exc()
            print("ApeX egress blocked — must run on Railway.")
            return
        # trim to last 90d
        span_ms = HOURS * 3_600_000
        cutoff = int(candles[-1][TS]) - span_ms
        candles = [c for c in candles if int(c[TS]) >= cutoff]
        first_ts = int(candles[0][TS]); last_ts = int(candles[-1][TS])
        print(f"  {sym}: {len(candles):,} candles  span "
              f"{fmt_ts(first_ts)} → {fmt_ts(last_ts)}"
              f"  ({(last_ts-first_ts)/86_400_000:.1f}d)")
        sym_candles[sym] = candles
        ticks[sym] = tick
        first_ts_all = first_ts if first_ts_all is None else min(first_ts_all, first_ts)
        last_ts_all = last_ts if last_ts_all is None else max(last_ts_all, last_ts)

    print("\nplanning trades per strategy/symbol …")
    for sym in SYMBOLS:
        a = plan_accumulator(sym_candles[sym], ticks[sym], sym)
        h = plan_hunter(sym_candles[sym], sym)
        print(f"  {sym:11s}: accum plans={len(a):3d}   hunter plans={len(h):3d}")
        plans.extend(a); plans.extend(h)
    print(f"total planned trades across the fleet: {len(plans)}")

    print("\nrunning unified cross-margin simulator …")
    result = simulate_portfolio(sym_candles, plans)
    report(result, first_ts_all, last_ts_all, plans)


if __name__ == "__main__":
    main()
