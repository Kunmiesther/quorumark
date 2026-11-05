# Closed-position P&L reconciliation

## Failure and scope

The venue snapshot reader correctly marks absent exposure closed with unknown
realized P&L. The independent fill matcher records realized results in `trades`,
but previously nothing settled that accounting into the closed `positions` row.
Consequently `LIVE_MANDATE_PNL_UNCONFIRMED` could remain indefinitely.

The added RPC bridges only complete lots whose owner, connection, exchange,
symbol, direction, entry/exit times, sizes, prices and trading fees agree with
both the position snapshot and the fill ledger. It does not infer missing P&L
from the last unrealized mark. Valid zero P&L is distinct from unknown P&L.

## Invariants

- No UI, wallet, order, leverage, allocation, plan, loss-limit or routing changes.
- No deletion/reset of positions, trades, residual fills or ingestion cursors.
- Only closed live ApeX/Aster positions with null P&L are eligible.
- Dry-run is the default. Internal execution is service-role-only.
- Partial campaigns, overlapping positions, flips, missing fee evidence and
  inconsistent historical FIFO attribution are explicitly left unresolved.
- The FIFO bridge uses fill-price profit/loss less trading fees; **funding is excluded**.
  The separate ApeX reported-P&L bridge uses `totalPnl` from official closing
  history. It labels that basis explicitly; its fee breakdown and funding
  inclusion are unknown, not guessed or subtracted a second time.
- Existing null Omni fee currency is interpreted as USDT only for the four
  explicitly supported USDT perpetuals, per the venue's settlement specification:
  https://api-docs.omni.apex.exchange/ (Margin / settleCurrency).
- The settlement ledger retains a full before-image and evidence IDs; a unique
  trade-to-position link prevents assigning the same closed trade twice.
- The original closure timestamp is preserved despite the normal updated-at
  trigger, so historical corrections cannot move into a later mandate period.
- A five-minute minimum closure age avoids settling a still-arriving close.
- Every successful venue snapshot retries old unresolved closures. A failed
  accounting RPC does not discard a valid venue snapshot; its status is logged.

## Verification

`node scripts/test-closed-position-pnl.mjs [absolute-pglite-module-path]`
uses isolated in-memory PostgreSQL, including the existing updated-at trigger.
It tests replay, before-image preservation, zero/loss/short results, split fills,
late arrival, cross-account/venue/book isolation, missing/mismatched evidence,
overlap, and denied public execution. It never accesses a production database.

The migration adds the RPC and audit ledgers; it does not backfill by itself.
The reconciler calls the RPC after venue observation, never from order admission.
Operators can preview one account with:

```sql
select public.reconcile_closed_position_pnl(:owner_uuid, :connection_uuid, false);
```

Only after reviewing the preview should an authorized operator use `true`.
Recheck the mandate's actual cumulative recorded P&L afterward. Clearing unknown
accounting is **not** permission to reset a loss-stop or claim a route is ready.

## Remaining historical work

This is deliberately not a generic FIFO-history rewrite. Legacy ApeX BTC rows
with mismatched entry histories require venue statement/fill evidence before
correction. The existing symbol-based automation attribution also needs review;
this repair preserves it rather than silently removing losses from a plan.

## ApeX recovery extension

The read-only client now paginates fills and closing history with bounded page
counts and a fixed time window. Malformed, duplicate or truncated fill history
fails the read rather than advancing the ingest cursor past unread fills.

`reconcile_apex_reported_pnl(owner, connection, false)` previews venue-reported
closing P&L. It accepts only one closing event within the observed position's
lifetime, with matching entry, quantity, exit fill and open/flat snapshots.
Partial closes, overlap and inconsistent evidence remain unresolved. Applied
results retain before-images and a unique event link. Run the isolated checks:
`node scripts/test-apex-reported-pnl.mjs`.

Order recovery checks exact, hashed venue client IDs (matching the signer), not
internal intent IDs. Only positive terminal-order evidence plus a fresh flat
symbol and no resting orders may resolve an uncertain intent. Missing orders
remain uncertain. Observations rotate in bounded batches with a 15-minute
retry interval and retain an audit trail. No recovery path sends a venue order.

New campaign failures preserve accepted venue IDs and distinguish provably
unattempted rungs from attempted, uncertain orders. This prevents creating new
false reconciliation blockers without rewriting old campaign history. Tests:
`node scripts/test-apex-order-recovery.mjs` and the authoritative Python 3.11
signer CI suite. A passing deployment is not proof of trading readiness: check
remaining unknown orders, P&L and existing mandate loss stops independently.
