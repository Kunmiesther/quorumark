from __future__ import annotations

import numpy as np
import pandas as pd

from .contracts import evidence_hash
from .market_data import validate_candles
from .models import BacktestRequest, BacktestResponse, Execution, Performance, Signal


def _fill_price(price: float, side: str, slippage_bps: float, entering: bool) -> float:
    adverse = 1 if side == "long" else -1
    direction = adverse if entering else -adverse
    return price * (1 + direction * slippage_bps / 10_000)


def run_reference_backtest(request: BacktestRequest) -> BacktestResponse:
    """Run a deterministic long-only crossover with candle-based exits.

    Signals are formed from completed closes and filled on the next open. Stop
    and target levels are evaluated only on later candle ranges. If both levels
    are touched in one candle, the stop wins conservatively.
    """
    candles = validate_candles(request.candles, source=request.source)
    params = request.strategy
    frame = pd.DataFrame([c.model_dump() for c in candles])
    frame["fast"] = frame["close"].rolling(params.fast_window).mean()
    frame["slow"] = frame["close"].rolling(params.slow_window).mean()
    cash = float(params.initial_cash)
    quantity = 0.0
    entry_price = 0.0
    entry_fee = 0.0
    position_id: str | None = None
    fees = realized = gross_realized = 0.0
    wins = completed_trades = 0
    signals: list[Signal] = []
    executions: list[Execution] = []
    equity_curve: list[float] = []

    for index, candle in enumerate(candles):
        row = frame.iloc[index]
        if quantity > 0 and position_id and (params.stop_loss_pct > 0 or params.take_profit_pct > 0):
            stop = entry_price * (1 - params.stop_loss_pct / 100)
            target = entry_price * (1 + params.take_profit_pct / 100)
            hit_stop = params.stop_loss_pct > 0 and candle.low <= stop
            hit_target = params.take_profit_pct > 0 and candle.high >= target
            if hit_stop or hit_target:
                exit_reason = "stop_loss" if hit_stop else "take_profit"
                exit_reference = stop if hit_stop else target
                exit_price = _fill_price(exit_reference, "long", params.slippage_bps, False)
                full_exit = hit_stop or params.partial_take_profit_pct >= 100
                exit_quantity = quantity if full_exit else quantity * params.partial_take_profit_pct / 100
                gross = exit_quantity * exit_price
                fee = gross * params.fee_bps / 10_000
                trade_gross = exit_quantity * (exit_price - entry_price)
                allocated_entry_fee = entry_fee * exit_quantity / quantity
                trade_pnl = trade_gross - fee - allocated_entry_fee
                cash += gross - fee
                realized += trade_pnl
                gross_realized += trade_gross
                fees += fee
                executions.append(Execution(timestamp=candle.timestamp, side="sell", price=exit_price, quantity=exit_quantity, fee=fee, realized_pnl=trade_pnl, order_type="exit" if full_exit else "partial_exit", position_id=position_id, slippage=abs(exit_price - exit_reference), reason=exit_reason))
                if full_exit:
                    completed_trades += 1
                    wins += int(trade_pnl > 0)
                    quantity = 0
                    entry_price = entry_fee = 0
                    position_id = None
                else:
                    quantity -= exit_quantity
                    entry_fee -= allocated_entry_fee

        equity_curve.append(round(cash + quantity * candle.close, 8))
        if index + 1 >= len(candles) or pd.isna(row["fast"]) or pd.isna(row["slow"]):
            continue
        next_candle = candles[index + 1]
        if float(row["fast"]) > float(row["slow"]) and quantity == 0:
            price = _fill_price(next_candle.open, "long", params.slippage_bps, True)
            allocation = cash * params.allocation_pct / 100
            quantity = allocation / price
            fee = allocation * params.fee_bps / 10_000
            cash -= allocation + fee
            fees += fee
            entry_price = price
            entry_fee = fee
            position_id = f"pos_{len(executions):06d}"
            signals.append(Signal(timestamp=next_candle.timestamp, side="long", price=price, reason="fast average above slow average", strategy_version=request.strategy_version))
            executions.append(Execution(timestamp=next_candle.timestamp, side="buy", price=price, quantity=quantity, fee=fee, order_type="entry", position_id=position_id, slippage=abs(price - next_candle.open), reason="moving_average_entry"))
        elif float(row["fast"]) < float(row["slow"]) and quantity > 0:
            price = _fill_price(next_candle.open, "long", params.slippage_bps, False)
            gross = quantity * price
            fee = gross * params.fee_bps / 10_000
            trade_pnl = quantity * (price - entry_price) - fee - entry_fee
            cash += gross - fee
            realized += trade_pnl
            gross_realized += quantity * (price - entry_price)
            fees += fee
            completed_trades += 1
            wins += int(trade_pnl > 0)
            signals.append(Signal(timestamp=next_candle.timestamp, side="flat", price=price, reason="fast average below slow average", strategy_version=request.strategy_version))
            executions.append(Execution(timestamp=next_candle.timestamp, side="sell", price=price, quantity=quantity, fee=fee, realized_pnl=trade_pnl, order_type="exit", position_id=position_id, slippage=abs(price - next_candle.open), reason="moving_average_exit"))
            quantity = 0
            entry_price = entry_fee = 0
            position_id = None

    final_close = candles[-1].close
    unrealized = quantity * (final_close - entry_price) if quantity else 0
    final_equity = cash + quantity * final_close
    curve = np.asarray(equity_curve, dtype=float)
    peaks = np.maximum.accumulate(curve)
    drawdown = np.where(peaks > 0, (peaks - curve) / peaks * 100, 0)
    performance = Performance(initial_cash=params.initial_cash, final_equity=round(final_equity, 8), realized_pnl=round(realized, 8), unrealized_pnl=round(unrealized, 8), realized_gross_pnl=round(gross_realized, 8), fees=round(fees, 8), return_pct=round((final_equity / params.initial_cash - 1) * 100, 6), max_drawdown_pct=round(float(drawdown.max(initial=0)), 6), win_rate_pct=round((wins / completed_trades) * 100, 6) if completed_trades else 0, trade_count=completed_trades)
    evidence = {"strategy_version": request.strategy_version, "source": request.source, "candles": [c.model_dump(mode="json") for c in candles], "performance": performance.model_dump(mode="json")}
    digest = evidence_hash(evidence)
    return BacktestResponse(signals=signals, executions=executions, performance=performance, equity_curve=[round(float(v), 8) for v in curve], data_source=request.source, evidence_hash=digest, backtest_id="bt_" + digest[:20])
