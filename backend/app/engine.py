from __future__ import annotations

import numpy as np
import pandas as pd

from .models import BacktestRequest, BacktestResponse, Execution, Performance, Signal


def run_reference_backtest(request: BacktestRequest) -> BacktestResponse:
    """Run a long-only moving-average crossover without look-ahead bias.

    Signals are formed from closes through candle i and executed at candle i+1
    open. The final open position is marked to the final close and is not
    counted as realized P&L.
    """
    params = request.strategy
    frame = pd.DataFrame([c.model_dump() for c in request.candles]).sort_values("timestamp")
    frame["fast"] = frame["close"].rolling(params.fast_window).mean()
    frame["slow"] = frame["close"].rolling(params.slow_window).mean()

    cash = float(params.initial_cash)
    quantity = 0.0
    entry_price = 0.0
    fees = 0.0
    realized = 0.0
    wins = 0
    completed_trades = 0
    signals: list[Signal] = []
    executions: list[Execution] = []
    equity_curve: list[float] = []

    for index in range(len(frame)):
        row = frame.iloc[index]
        mark_equity = cash + quantity * float(row["close"])
        equity_curve.append(round(mark_equity, 8))
        if index + 1 >= len(frame) or pd.isna(row["fast"]) or pd.isna(row["slow"]):
            continue

        next_row = frame.iloc[index + 1]
        crossover_up = float(row["fast"]) > float(row["slow"])
        crossover_down = float(row["fast"]) < float(row["slow"])
        if crossover_up and quantity == 0:
            price = float(next_row["open"])
            allocation = cash * params.allocation_pct / 100
            quantity = allocation / price
            fee = allocation * params.fee_bps / 10_000
            cash -= allocation + fee
            fees += fee
            entry_price = price
            timestamp = next_row["timestamp"]
            signals.append(Signal(timestamp=timestamp, side="long", price=price, reason="fast average above slow average"))
            executions.append(Execution(timestamp=timestamp, side="buy", price=price, quantity=quantity, fee=fee))
        elif crossover_down and quantity > 0:
            price = float(next_row["open"])
            gross = quantity * price
            fee = gross * params.fee_bps / 10_000
            trade_pnl = quantity * (price - entry_price) - fee
            cash += gross - fee
            realized += trade_pnl
            fees += fee
            completed_trades += 1
            wins += int(trade_pnl > 0)
            timestamp = next_row["timestamp"]
            signals.append(Signal(timestamp=timestamp, side="flat", price=price, reason="fast average below slow average"))
            executions.append(Execution(timestamp=timestamp, side="sell", price=price, quantity=quantity, fee=fee, realized_pnl=trade_pnl))
            quantity = 0.0
            entry_price = 0.0

    final_close = float(frame.iloc[-1]["close"])
    final_equity = cash + quantity * final_close
    equity_curve.append(round(final_equity, 8))
    curve = np.asarray(equity_curve, dtype=float)
    peaks = np.maximum.accumulate(curve)
    drawdown = np.where(peaks > 0, (peaks - curve) / peaks * 100, 0)
    performance = Performance(
        initial_cash=params.initial_cash,
        final_equity=round(final_equity, 8),
        realized_pnl=round(realized, 8),
        fees=round(fees, 8),
        return_pct=round((final_equity / params.initial_cash - 1) * 100, 6),
        max_drawdown_pct=round(float(drawdown.max(initial=0)), 6),
        win_rate_pct=round((wins / completed_trades) * 100, 6) if completed_trades else 0,
        trade_count=completed_trades,
    )
    return BacktestResponse(signals=signals, executions=executions, equity_curve=[round(float(v), 8) for v in curve], performance=performance)
