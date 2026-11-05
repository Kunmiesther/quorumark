# SynFutures campaign admission

The existing `validate_live_mandate_entry` INSERT trigger now admits native
SynFutures intents under the same mandate lock as Aster and ApeX. Every native
entry requires a campaign key. Native symbols are BTC-USDC and ETH-USDC, MARKET
orders only, and configured leverage must be an integer between 1 and 33.
After locking the owned mandate and rereading its strategy, the trigger locks
the owned SynFutures mainnet/production connection and checks verified status,
trade permission, verified permissions and live authorization. No connection
flags, approved limits or leverage settings are modified by the migration.

Schedule, pause, realized-loss, unknown-PNL, daily-campaign and open-position
checks apply. Five rungs share one campaign slot; a sixth or changed owner,
connection, venue, symbol or side is rejected. Unresolved intents retain
capacity until a newer reconciled closed position releases it. Reductions
remain exempt from entry limits so pausing entries cannot prevent recovery.
This exemption is database admission, not proof of an executable on-chain exit.

Owner execution-settings edits also recognize verified SynFutures routes. A
mandate containing multiple venues uses their lowest leverage ceiling, including
33x for SynFutures. Ownership, stale-revision and verified-permission checks
remain in force; an edit does not enable a connection or a strategy.

Validation executes the actual PL/pgSQL in disposable PostgreSQL: 36 scenarios
cover native permissions and ownership, venue ceilings, identity, capacity,
competing submissions, schedule, pause, loss, unknown PNL and exit exemption.
Owner and stale-revision settings checks, the native settings ceiling, and
unchanged strategy enablement are tested. The existing Aster/ApeX mandate-settings regression also passes. CI runs the
native database suite on every PR and main push. The remote migration was
applied and its enabled trigger/security-invoker configuration verified. A
production insert without a campaign was rejected and rolled back by the
trigger; no verification intent was persisted or sent to a venue.

Worker native candles, entry routing and exact account/quote sizing were
delivered in PR105; mainnet/production watch scoping was delivered in PR106.
This migration closes the database-admission gap in item 2. It does not complete
the live campaign executor: the signer still refuses entries with
SYNFUTURES_PROTECTIVE_EXIT_REQUIRED after a successful preflight. Item 3 must
deliver monitored protective exits and recovery, including the deployed v1
module's session-expiry restriction, before any entry reservation/broadcast is
enabled. The native five-rung scheduler and submission integration must be
validated with that protection lifecycle; five database rows are not five
working venue orders. Operator provisioning and owner-reviewed funding/session
authorization remain separate activation prerequisites.
