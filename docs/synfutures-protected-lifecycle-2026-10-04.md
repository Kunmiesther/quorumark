# SynFutures native lifecycle

This adds supervision and a durable native campaign queue to the registered Base Safe and its deployed v1 module. Existing connection, deployment, strategy evaluation, CEX execution, historical intents and module bytecode remain in place. No connection is activated, funded or granted trading permission by this change.

## Native execution contract

The worker continues to evaluate the existing Turtle strategies and RSI/timeframe gates. A native strategy request contains an exact configured total campaign margin and leverage (1–33), not a quoted size or an authority flag. The private signer reads and verifies the owned registered account and native quotes. Five equal margin rungs use the shared ladder span and hard-stop constants; the first rung waits for adverse movement. No transaction is sent when the campaign is admitted. Subsequent rungs require canonical finalized matching module events.

The native profit policy is explicit `native_take_profit_bps` (1–9999), measured from the actual position entry notional, and applies after all five finalized rungs. This is an explicit native execution policy, not a claim of exact V3 Pine or deferred-council TP parity. It must be selected and acknowledged before native execution. Sweep remains blocked pending its separate native execution parity.

Stops and profit exits are **locally monitored**, not resting venue orders. Pausing entries also requests reduction of managed exposure. Session expiry is checked with a five-minute exit buffer. RPC outages, operator gas failure, revoked sessions or unexplained exposure retain capacity and require recovery; they never imply flat exposure. `native_locally_monitored_exits_accepted=true` is required in the owned native strategy parameters.

## Journal, lease and recovery

A fresh, fully bound canonical mined success may authorize only a protected zero-margin reduction before finality. It never authorizes another entry or becomes a finalized fill. Uncertain/reorged/unreadable receipts remain locked. Account and module nonces remain unique. Campaign leases fence replicas and abandoned preparation. A failed action is retained; a reduction retry needs a known never-reserved preparation or a definitive reverted transaction. No uncertain transaction is resent.

The owner recovery screen reads actual native positions even with entries paused or a session expired. It reviews one step at a time: enable the registered module if needed, configure the registered owner for at most five minutes with a one-wei WAD margin budget, then execute an atomic reduce-only module trade with zero margin. No deposit, token approval, key collection or arbitrary execution is included. The browser records uncertainty before requesting a wallet transaction, validates owner/network identity, coordinates tabs and verifies receipts against the exact reviewed calldata hash. A missing wallet response requires locating that transaction in wallet activity; it never retries automatically.

## Accounting

Open position estimates are labelled estimates. Closure requires finalized canonical Instrument history from the flat baseline: actual native balance change minus external `Trade.amount` and `Adjust.net` margin movements. Native balance includes fees, funding and social loss. Missing events, unsupported liquidity/liquidation paths, reorgs or unknown finality do not become zero PNL. Verified settlement writes the common closed position and releases campaign capacity. Unknown native PNL blocks entries under the existing mandate; existing daily, schedule, loss and position limits continue to apply.

## Deployment configuration

Both broker `SYNFUTURES_MAINNET_AUTOMATION_ENABLED` and private signer `SYNFUTURES_SIGNER_AUTOMATION_ENABLED` default off. The worker's protection endpoint remains callable with entries off. The private signer additionally needs a configured Base RPC and `TURTLEBOT_SYNFUTURES_OPERATOR_BINDINGS`, a private connection-ID mapping containing the exact owned user ID, a dedicated operator key and explicit `gas_limits` (`max_gas`, `max_fee_per_gas`, `max_total_gas_cost`, all positive integer wei/gas values). This configuration never crosses the browser or worker proxy. The on-chain session, market limits, margin reserve and operator gas must independently verify. Entry reserves gas budget for both entry and exit.

The current owner connection remains read-only. Completing this software layer does not complete owner funding/session activation or establish strategy profitability.

## Verification

Disposable PostgreSQL tests cover all five rungs, canonical progression, exact replay, leases, provisional-only reductions, uncertainty locks, failed exit retries, fenced preparation restarts, retained history and verified PNL loss gates. Python tests cover native readers, quote limits, private operator scope, campaign decisions, canonical/provisional receipts, recovery receipts, exact settlement and submission failures. Browser wallet tests cover identity changes, exact reductions, stale reviews and uncertain submissions. Broker tests cover owned scope, strict request fields and sanitized response DTOs. Real pinned Safe tests cover expired/disabled recovery and a stale reduction that cannot reverse exposure. No production order or funding transaction is part of verification.
