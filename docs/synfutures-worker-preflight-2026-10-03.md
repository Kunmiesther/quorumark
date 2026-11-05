# SynFutures worker integration — 2026-10-03

This change closes the native signal-feed, worker routing and exact entry
preflight gaps. It does not complete live activation or authorize transactions.
The connected account remains read-only; no strategy configuration, collateral,
session, operator key or live flag was changed.

## Implemented

- Native Base BTC-USDC and ETH-USDC feed, including 5m/15m event candles and
  1h/4h/1d candles. Pagination is bounded, ordered and pinned by indexed block
  hash. Partial scans, stale/erroring indexes, malformed events and block changes
  refuse evaluation. Empty intervals carry forward only after a complete scan.
- Short-candle OHLC follows block number and global log index, not transaction
  hash order. Signal tick tolerance uses the local SynFutures geometric price
  increment. Execution tick bounds use an integer port of official TickMath.
- The worker evaluates SynFutures through the existing strategy/reducer gates
  and adds read-only native market watch targets for connected accounts,
  and sends a dedicated native request. USDT symbols, SOL/XRP, guessed margin,
  unknown leverage and unratified Sweep live translation are refused. Uncertain
  responses retain the connection/symbol execution lock.
- Broker validates native USDC symbols and exact decimal margin, rejects caller
  addresses/size/authority flags and defaults SynFutures automation off. The
  private HMAC signer route performs SynFutures preflight rather than ApeX sizing.
- Owner-scoped worker-ingest context verifies the exchange, registration,
  active verified wallet and account binding. It never provides a key or grants
  trade permission to a read-only connection.
- Signer rereads registered code, canonical Safe singleton, owners, threshold,
  module binding, enabled session, market limits, Gate collateral, both positions
  and venue settings at one canonical Base block. Unresolved transaction hashes
  block new entries. Native quotes preserve exact signed WAD size. Fees reduce the
  permitted notional; the signer requests a smaller quote instead of increasing
  the owner's margin. Venue minimums, initial margin, leverage, size/notional,
  session budget, portfolio exposure and adverse slippage are enforced.

## Remaining activation work

The route ends with `SYNFUTURES_PROTECTIVE_EXIT_REQUIRED` after a successful
preflight. It does not insert an order intent, reserve a transaction or broadcast.
This is a deliberate release boundary, not an implementation of working exits.

Item #2 therefore cannot yet be marked fully complete: durable SynFutures campaign
admission and the final call to the existing submission core remain disconnected
until the protected campaign lifecycle is implemented and tested. The existing
SQL mandate trigger still admits only ApeX/Aster; it must be extended and tested
before any SynFutures entry is released. Do not bypass it or omit the campaign key.

The existing five-rung campaign contract must not become an immediate market
entry simply because the deployed module supports `executeTrade`. Item #3 must
provide verified position monitoring/protective exits, partial campaign handling,
session-expiry handling and owner recovery. v1 session expiry/revocation blocks
operator reductions too. Owner authorization, exact funding/session calls and
Base-fork lifecycle evidence are also required before live entries.

## Verification

Focused local checks passed: 268 Python tests plus 33 reconciliation subtests,
90 broker tests and broker TypeScript checking. The owner-context test also
passed for wrong owner, missing registration, revoked wallet and read-only access.
Signer tests use mocked RPC/venue data and are not a mainnet execution proof.
Authoritative Python 3.11 CI remains the deployment gate.

Live public reads verified native hourly, four-hour and daily data. The provider
returns null historical metadata hashes when pinned by number, while hash-pinned
queries preserve the observed hash; the feed explicitly uses the latter. No
transaction, signature, approval or funding action was performed.
