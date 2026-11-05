"""Research-only 15m sweep + four-rung shared cross-margin backtest.

This does not alter TurtleBot's paper or live engines. It evaluates the owner
proposal on one shared account: a sweep is detected on completed 15m candles,
then four equal-quantity rungs are placed 0.5% apart. Rung 1 fills at the
confirmation close; deeper rungs can fill only on later candles.
"""
from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

from backtest_pnl_sweep_sniper_stack_30d import _aggregate_15m
from htf_bos import aggregate_1h, aggregate_4h, detect_htf_bos
from sweep_signal import CLOSE, HIGH, LOW, TS, atr_series, detect_sweep

SYMBOLS = [
    "BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT",
    "ADA-USDT", "AVAX-USDT", "LINK-USDT", "SUI-USDT", "LTC-USDT",
]
STARTING_EQUITY = 2_000.0
LEVERAGE = 100.0
RISK_PER_CAMPAIGN = 0.005
MAX_TOTAL_RISK = 0.02
RUNG_STEP = 0.005
RUNG_COUNT = 4
FEE_RATE = 0.0004
MMR = 0.005
TP_TIERS = ((0.50, 1.0), (0.30, 1.5), (0.20, 2.5))
MAX_HOLD_15M_BARS = 192
STEP_SECONDS = 300
BARS_5M = 5 * 288
FIXED_END_SECONDS = 1_789_033_500


def fetch_coinbase(symbol: str, bar_count: int = BARS_5M) -> list[list]:
    product = symbol.replace("-USDT", "-USD")
    end = FIXED_END_SECONDS
    rows: dict[int, list] = {}
    while len(rows) < bar_count:
        start = end - 299 * STEP_SECONDS
        query = urllib.parse.urlencode({"granularity": STEP_SECONDS, "start": start, "end": end})
        request = urllib.request.Request(
            f"https://api.exchange.coinbase.com/products/{product}/candles?{query}",
            headers={"User-Agent": "TurtleBot-Backtest/1.0", "Accept": "application/json"},
        )
        payload = json.loads(urllib.request.urlopen(request, timeout=20).read())
        if not payload:
            raise RuntimeError(f"No candles returned for {product}")
        for ts, low, high, open_, close, volume in payload:
            rows[int(ts) * 1000] = [int(ts) * 1000, float(open_), float(high), float(low), float(close), float(volume)]
        end = min(int(row[0]) for row in payload) - STEP_SECONDS
        time.sleep(0.12)
    return [rows[key] for key in sorted(rows)][-bar_count:]


def bos_state(candles: list[list], timeframe: str) -> str:
    aggregated = aggregate_1h(candles) if timeframe == "1h" else aggregate_4h(candles)
    if len(aggregated) < 20:
        return "none"
    return detect_htf_bos(aggregated, 0.0).state


def build_signals(candles_5m: list[list]) -> tuple[list[list], dict[int, object], dict[int, str]]:
    candles_15m = _aggregate_15m(candles_5m)
    atr = atr_series(candles_15m)
    signals: dict[int, object] = {}
    environment: dict[int, str] = {}
    for index in range(60, len(candles_15m)):
        timestamp = int(candles_15m[index][TS])
        cutoff = timestamp + 15 * 60 * 1000 - 1
        completed_5m = [row for row in candles_5m if int(row[TS]) <= cutoff]
        state_4h = bos_state(completed_5m, "4h")
        state_1h = bos_state(completed_5m, "1h")
        environment[timestamp] = state_4h
        signal = detect_sweep(candles_15m[: index + 1], atr[: index + 1], state_4h, 0.0)
        if signal is None:
            continue
        if signal.direction == "long" and state_1h == "bearish_bos":
            continue
        if signal.direction == "short" and state_1h == "bullish_bos":
            continue
        signals[timestamp] = signal
    return candles_15m, signals, environment


@dataclass
class Position:
    symbol: str
    side: str
    opened_ts: int
    stop: float
    pending: list[tuple[float, float]]
    fills: list[tuple[float, float]] = field(default_factory=list)
    closed_qty: float = 0.0
    realized: float = 0.0
    entry_fees: float = 0.0
    tier_hit: list[bool] = field(default_factory=lambda: [False, False, False])
    bars_held: int = 0

    @property
    def filled_qty(self) -> float:
        return sum(qty for _, qty in self.fills)

    @property
    def avg_entry(self) -> float:
        qty = self.filled_qty
        return sum(price * size for price, size in self.fills) / qty if qty else 0.0

    @property
    def live_qty(self) -> float:
        return max(0.0, self.filled_qty - self.closed_qty)


def mark_pnl(position: Position, price: float) -> float:
    move = price - position.avg_entry if position.side == "long" else position.avg_entry - price
    return position.realized + move * position.live_qty


def close_qty(position: Position, qty: float, price: float) -> float:
    qty = min(qty, position.live_qty)
    move = price - position.avg_entry if position.side == "long" else position.avg_entry - price
    pnl = move * qty - price * qty * FEE_RATE
    position.realized += pnl
    position.closed_qty += qty
    return pnl


def simulate(data: dict[str, list[list]], signals: dict[str, dict[int, object]], env: dict[str, dict[int, str]]) -> dict:
    rows = {symbol: {int(row[TS]): row for row in series} for symbol, series in data.items()}
    timeline = sorted({timestamp for series in rows.values() for timestamp in series})
    positions: dict[str, Position] = {}
    balance = STARTING_EQUITY
    closed: list[dict] = []
    peak = balance
    max_drawdown = 0.0
    max_concurrent = 0
    max_notional = 0.0
    liquidated = False
    signal_count = sum(len(items) for items in signals.values())

    for timestamp in timeline:
        # Manage existing campaigns before admitting new signals.
        for symbol, position in list(positions.items()):
            candle = rows[symbol].get(timestamp)
            if candle is None:
                continue
            position.bars_held += 1
            remaining = []
            for price, qty in position.pending:
                touched = candle[LOW] <= price if position.side == "long" else candle[HIGH] >= price
                if touched:
                    position.fills.append((price, qty))
                    fee = price * qty * FEE_RATE
                    position.entry_fees += fee
                    balance -= fee
                else:
                    remaining.append((price, qty))
            position.pending = remaining
            avg = position.avg_entry
            risk_unit = abs(avg - position.stop)
            stop_hit = candle[LOW] <= position.stop if position.side == "long" else candle[HIGH] >= position.stop
            if stop_hit:
                close_qty(position, position.live_qty, position.stop)
                balance += position.realized
                closed.append({"symbol": symbol, "pnl": position.realized - position.entry_fees, "reason": "stop"})
                del positions[symbol]
                continue

            for tier_index, (fraction, reward) in enumerate(TP_TIERS):
                if position.tier_hit[tier_index] or position.live_qty <= 0 or risk_unit <= 0:
                    continue
                target = avg + reward * risk_unit if position.side == "long" else avg - reward * risk_unit
                hit = candle[HIGH] >= target if position.side == "long" else candle[LOW] <= target
                if hit:
                    close_qty(position, position.filled_qty * fraction, target)
                    position.tier_hit[tier_index] = True
                    if tier_index == 0:
                        position.stop = avg
                        position.pending.clear()

            state = env[symbol].get(timestamp, "none")
            required = "bullish_bos" if position.side == "long" else "bearish_bos"
            runner_flip = position.tier_hit[1] and state != required
            timed_out = position.bars_held >= MAX_HOLD_15M_BARS
            if position.live_qty <= 1e-12 or runner_flip or timed_out:
                reason = "targets" if position.live_qty <= 1e-12 else ("4h_flip" if runner_flip else "timeout")
                if position.live_qty > 0:
                    close_qty(position, position.live_qty, float(candle[CLOSE]))
                balance += position.realized
                closed.append({"symbol": symbol, "pnl": position.realized - position.entry_fees, "reason": reason})
                del positions[symbol]

        marks = {symbol: float(rows[symbol][timestamp][CLOSE]) for symbol in rows if timestamp in rows[symbol]}
        open_pnl = sum(mark_pnl(position, marks.get(symbol, position.avg_entry)) for symbol, position in positions.items())
        equity = balance + open_pnl

        # Each campaign risks 0.5%; four campaigns cap combined risk at 2%.
        for symbol in SYMBOLS:
            signal = signals[symbol].get(timestamp)
            if signal is None or symbol in positions or len(positions) >= int(MAX_TOTAL_RISK / RISK_PER_CAMPAIGN):
                continue
            base = float(signal.entry)
            direction = signal.direction
            sign = -1.0 if direction == "long" else 1.0
            rung_prices = [base * (1.0 + sign * RUNG_STEP * index) for index in range(RUNG_COUNT)]
            stop = base * (1.0 + sign * RUNG_STEP * RUNG_COUNT)
            planned_avg = sum(rung_prices) / RUNG_COUNT
            risk_distance = abs(planned_avg - stop)
            total_qty = equity * RISK_PER_CAMPAIGN / risk_distance
            max_qty = equity * LEVERAGE / planned_avg
            total_qty = min(total_qty, max_qty)
            rung_qty = total_qty / RUNG_COUNT
            position = Position(symbol, direction, timestamp, stop, list(zip(rung_prices[1:], [rung_qty] * 3)))
            position.fills.append((rung_prices[0], rung_qty))
            fee = rung_prices[0] * rung_qty * FEE_RATE
            position.entry_fees += fee
            balance -= fee
            positions[symbol] = position

        open_notional = sum(position.avg_entry * position.live_qty for position in positions.values())
        max_notional = max(max_notional, open_notional)
        max_concurrent = max(max_concurrent, len(positions))
        open_pnl = sum(mark_pnl(position, marks.get(symbol, position.avg_entry)) for symbol, position in positions.items())
        equity = balance + open_pnl
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
        maintenance = open_notional * MMR
        if open_notional and equity <= maintenance:
            liquidated = True
            break

    # Settle remaining campaigns at the final completed candle.
    if not liquidated:
        for symbol, position in list(positions.items()):
            final_price = float(data[symbol][-1][CLOSE])
            close_qty(position, position.live_qty, final_price)
            balance += position.realized
            closed.append({"symbol": symbol, "pnl": position.realized - position.entry_fees, "reason": "window_end"})

    wins = [trade for trade in closed if trade["pnl"] > 0]
    losses = [trade for trade in closed if trade["pnl"] <= 0]
    gross_win = sum(trade["pnl"] for trade in wins)
    gross_loss = -sum(trade["pnl"] for trade in losses)
    return {
        "signals": signal_count,
        "trades": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": 100.0 * len(wins) / len(closed) if closed else 0.0,
        "net_pnl": balance - STARTING_EQUITY,
        "ending_equity": balance,
        "profit_factor": gross_win / gross_loss if gross_loss else math.inf,
        "max_drawdown": max_drawdown,
        "max_concurrent": max_concurrent,
        "max_notional": max_notional,
        "liquidated": liquidated,
        "by_symbol": {symbol: round(sum(trade["pnl"] for trade in closed if trade["symbol"] == symbol), 4) for symbol in SYMBOLS},
        "by_exit": {reason: sum(trade["reason"] == reason for trade in closed) for reason in sorted({trade["reason"] for trade in closed})},
    }


def main() -> None:
    raw = {symbol: fetch_coinbase(symbol) for symbol in SYMBOLS}
    prepared = {symbol: build_signals(series) for symbol, series in raw.items()}
    data = {symbol: item[0] for symbol, item in prepared.items()}
    signals = {symbol: item[1] for symbol, item in prepared.items()}
    environment = {symbol: item[2] for symbol, item in prepared.items()}
    print(json.dumps(simulate(data, signals, environment), sort_keys=True))


if __name__ == "__main__":
    main()
