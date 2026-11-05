# Strategy Spec v1 — Accumulator (DCA)

> **Authoritative source = `user_strategy.params`. This doc mirrors it; the row wins on any conflict.**
>
> Transcribed verbatim from `user_strategy.params` (spec_version `v1`, strategy slug `dca`).
> Do not edit this document to change strategy behavior — edit the row.

---

## Top-level

- `spec_version`: `v1`
- `ratified`: `true`
- `market`: `futures`
- `margin_mode`: `cross`
- `one_position_at_a_time`: `true`
- `symbols`: `["BTC", "ETH", "SOL", "ARB", "XRP"]`

## capital

- `max_usd`: `500`
- `floor_usd`: `100`
- `variable`: `true`

## canary

- `allocation_usd`: `30`  _(capital baseline, not margin; at 100× → $3 initial margin, $300 notional)_

## sizing

- `model`: `inverse_leverage`
- `notional_constant`: `10`  _(final owner ruling — supersedes obsolete `20`)_
- `margin_fraction_formula`: `10 / leverage`
- `cap`: `position_margin <= account_capital`

## entry

- `type`: `break_and_retest`
- `timeframe`: `5m`
- `ema_type`: `EMA`
- `ema_period`: `15`
- `confirmation`: `close_above_ema`
- `wick_tags_allowed`: `false`

## resize

- `direction`: `down`
- `unbounded`: `true`
- `depth_ceiling`: `null`
- `reanchor_average`: `true`
- `rebalance`: `sell_second_tranche_at_break_even`
- `gate`:
  - `price_below_last_resize_price`
  - `confirmed_5m_retest`
  - `prior_rebalance_filled`

## stop

- `active_after`: `first_rebalance`
- `level_mode`: `a_trailing`
- `level`: `most_recent_resize_or_retest_level`
- `trigger`: `confirmed_5m_close_below_level`
- `exit_overrides_resize`: `true`

## take_profit

- `basis`: `margin`
- `reference`: `current_average_entry`
- `ladder`:
  1. `{ at_pct: 200, action: sell_half }`
  2. `{ at_pct: 300, action: sell_half_of_remainder }`
  3. `{ at: original_first_entry_target, action: sell_rest_full_close }`

## junk_filter

- `enabled`: `true`
- `level_quality`:
  - `enabled_flag`: `false`
  - `min_score`: `null`
  - `source`: `ai_v2`
- `volatility_floor`:
  - `metric`: `atr_5m`
  - `threshold`: `null`

## safeguards

- `duplicate_submit_protection`: `true`
- `equity_floor_pct`: `null`
- `equity_floor_required_before_live`: `true`
- `kill_switch_checked_each_cycle`: `true`
- `max_slippage_guard`: `true`
- `rebalance_fill_required`: `true`
- `stale_feed_halt`: `true`

## ai_layers_v2

- `execution_health_watch`: `planned`
- `post_trade_analysis`: `planned`
- `regime_adaptive_safeguards`: `planned`
- `setup_quality_score`: `planned`
