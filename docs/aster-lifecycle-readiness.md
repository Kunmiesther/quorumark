# Aster lifecycle integration status — 2026-09-23

**Account reads and fill synchronization are verified in production. Both
connections remain paused by the owner. No execution smoke trade was placed.**

## 2026-09-24 reader, authentication and owner-control repair

This checkpoint supersedes older rollout notes below.

- PR #56 (`42fc4ad6`) restored authenticated reconciliation while accounts are
  paused. Both ApeX and Aster returned positions and open orders successfully.
  Unsupported zero-size Aster symbols no longer abort the entire account read.
- PR #57 (`4039ebf4`) repaired scheduled fill authentication using the existing
  server-only Supabase key. Gateway JWT verification remains enabled. Production
  cron calls returned HTTP 200; initial imports recorded 8 Aster fills and 100
  ApeX fills, then subsequent runs inserted zero duplicates. These were historical
  imports, not newly executed trades or proof of complete historical coverage.
- PR #58 (`54b474b8`) enforces the owner connection's live-entry switch before
  Aster preflight, leverage configuration and every rung. The authenticated worker
  reader rechecks ownership and permissions. Older readers fail closed. Reads and
  reduce-only exit paths remain available when new entries are paused.
- Railway signer, broker and worker deployed #58 successfully. Aster backend
  automation support is enabled on broker and signer; both account `is_live`
  switches remain false. No orders, positions or leverage were changed.
- Correction to the old worker count: four saved ApeX strategy rows exist;
  Aster's four scan-only fallback rows are NOT saved/armed Aster strategies.
  Aster needs its own reviewed plan before autonomous entries can occur.
- UI readiness follow-up separates verified Aster agent credentials from ApeX
  signing credentials, checks runtime support per venue, and requires a resumed
  matching connection before reporting a running strategy. This follow-up is
  pending its own CI and deployment verification.
- AI review remains advisory; observed reviews lacked the configured response
  quorum. Do not represent this checkpoint as fully verified AI position management.

## 2026-09-24 production release verification (latest)

This checkpoint supersedes the historical rollout-pending notes below.

- The owner's Actions budget reset cleared the runner block. Repaired the
  broker lockfile for CI's npm 10.9.8 in `5c2d1e3b`. Full PR verification
  passed: 1,740 tests passed and 39 skipped; 214 suites passed and one skipped.
  Signer Python 3.11, isolated SQL, Deno checks and preview deployment passed.
- PR #55 merged as `2259cb9c547cb9a4db29b9b6b26a83d3ada38611`.
  Production frontend deployment and the post-merge full verification,
  signer and SQL/Deno workflows all succeeded.
- Railway production deployments on that merge commit are SUCCESS:
  signer `99fee3e8-43fe-4791-96a4-6e26c8a111eb`, worker
  `ae6d9dab-5cc5-44c2-bf80-3942e05901ae`, broker
  `fcb29c60-2284-4d64-a3d6-744f14335760`.
  Broker `/readyz` returned HTTP 200 with `signer: ok` after broker rollout.
  Signer `/healthz` returned HTTP 200. Worker logs confirm authenticated
  worker-ingest heartbeat and eight scan rows loaded (four saved ApeX rows,
  plus four Aster scan-only fallback rows; see correction above).
- Supabase production edge versions deployed from reviewed source:
  worker-ingest v14, reconcile-live-positions v11, ingest-live-fills v16.
  Existing JWT settings were preserved. The two schema repairs described
  below are applied; the new ledgers contain no invented historical fills.
- Both venue connections remained paused on the final database checks.
  No orders were submitted, cancelled or closed during this rollout;
  the existing BTC short was not manipulated.
- Remaining verification: scheduled account readers filter for live-enabled
  connections, so the reconciliation smoke response (HTTP 200, count 0)
  does NOT verify Aster balances, positions, orders or fills while paused.
  The signer rejects an unauthenticated reconciliation request with HTTP 401;
  this verifies route protection, not successful account reconciliation.
- `ASTER_MAINNET_AUTOMATION_ENABLED` remains absent from the signer config
  and therefore defaults false. No trading environment flags were changed.
  Do not describe this release as armed Aster automation or advise that
  rearming alone will complete readiness. Authenticated account verification,
  deliberate activation and end-to-end execution evidence remain separate.


## 2026-09-24 production database repair and rollout checkpoint

- After the owner clicked Pause trading, a fresh production read confirmed
  `is_live=false` for both ApeX Omni and Aster. No orders or positions were
  closed/cancelled, and no financial controls were changed by the agent.
- Applied the reviewed `restore_execution_order_ledgers` and
  `aster_order_reconciliation` migrations to `sthdmulczzebfcmihhca`.
  Verified all three tables exist with RLS, no anonymous access, owner-only
  signed-in reads, no client inserts, and a service-only reconciliation RPC.
  The new intent/order ledgers are empty: no historical orders were invented.
  Both connection pause flags remained false after the repair.
- Security advisors reported no findings on the restored tables or new RPC.
  Existing unrelated definer-function and password-protection warnings remain.
- Full CI on `cdceaea6` built successfully and passed 1,724 tests, but two
  broker suites could not import Fastify because CI omitted broker dependencies.
  Commit `8bf31599` installs the locked broker dependencies, checks broker types,
  and preserves reconciliation/filled-size/reduce-only decision evidence.
  Local verification: the two affected broker suites (16 tests), focused worker
  suite (47 tests), and both isolated SQL suites passed.
- GitHub refused to start every new Actions job on `8bf31599`: account payment
  failure or spending limit was its generic error. The owner showed an Actions
  budget of $0 with Stop usage enabled, then changed it to $8. Attempt 2 started
  normally; signer, SQL and edge checks passed. No failed payment was confirmed.
- The resumed full job exposed an npm-version lockfile mismatch: npm 10.9.8
  required optional esbuild peer records absent from the npm 11 lockfile.
  Regenerated the broker lock with CI's npm version; npm 10 clean-install
  dry-run succeeds. Full CI must pass on the resulting commit before rollout.
- PR #55 remains unmerged. No edge function, Railway service, or production
  frontend was deployed in this repair step. Do not rearm based on the database
  repair alone. Remaining rollout: successful CI, deploy reviewed services and
  readers, then verify authenticated account reads and durable reconciliation.

## 2026-09-24 cancellation and restart recovery follow-up

- The sized close path now cancels pending entries only when their exact
  venue client IDs, sizes, sides, user and connection match persisted Aster
  intents. It validates the whole set first, leaves protective/manual orders
  alone, verifies terminal cancellation/fill states, then rereads exposure.
  It does not enlarge the requested close when a pending entry fills.
- Added database-backed observation of entry/close fills and cancellations.
  A row-locked RPC prevents decreasing filled size, changing venue identity,
  reopening terminal rows or crossing wallet/owner boundaries. Strategy IDs
  remain separate from their child order IDs. UNKNOWN is not flat or rejected.
- The regular position reconciliation job invokes the authenticated signer
  recovery route. Fresh positions still update if an older order is uncertain;
  the cycle explicitly reports that outstanding reconciliation requirement.
  Recovery never places/cancels orders or retries an unknown submission.
- A database reservation trigger serializes active campaigns per connection
  and symbol, allowing the five rungs of one campaign but refusing competing
  campaigns/closes while a previous intent is unresolved. This survives a
  worker restart. Active signing rows are given ten minutes before read-only
  recovery observes them; this is NOT a retry permission or lock expiry.
- Migration `20260924143659_aster_order_reconciliation.sql` depends on the
  missing base order-ledger restoration. Both are tested in isolated PostgreSQL.
  No migration has been applied to production. Dashboard inspection confirms
  this project's **LAST BACKUP: No backups**; a restore is not available there.
- The existing signer deployment is still commit `7af59c0e` (Sept 22), not
  this working tree. New GitHub checks cover SQL invariants and Deno types;
  the existing signer CI remains the authoritative Python 3.11 check.
- Pushed as `781c407e` plus edge-type compatibility fix `46338b48`, on existing
  PR #55. Python 3.11 signer CI, isolated PostgreSQL, Deno edge checks and the
  Vercel preview deployment pass. The full web regression job is still running.
  Local checks: 562 signer tests (includes uncommitted route-discovery tests),
  86 focused worker tests, 52 broker tests and broker typechecking pass.
- Rollout handoff: the production UI shows both connections LIVE and one open
  position. The owner has been asked to pause new entries with the two per-venue
  **Pause trading** buttons, leaving positions and protective orders untouched.
  Do not restore these missing shared execution ledgers while assuming active
  automated requests will remain blocked. No settings were changed by the agent.

### Controlled production sequence (pending owner pause)

1. Confirm both connections paused; do not close positions/cancel venue orders.
2. Reconfirm missing schema and apply the additive base-ledger migration, then
   the Aster reconciliation migration. Verify tables, RLS and RPC permissions.
3. Deploy the reviewed worker-ingest, signer, broker, read/reconciliation and
   worker changes with all trading settings unchanged; wait for health checks.
4. Verify owned Aster account/position/order reads and persisted recovery.
   Existing orders without ledger evidence remain unmanaged/unknown, never
   adopted or cancelled by a guessed identity. Never generate synthetic fills.
5. Report production verification evidence. The owner controls rearming; do
   not send a proof-of-life order or manipulate the existing BTC short.

## 2026-09-24 worker and reduce-only exit wiring

- Removed the unconditional Aster worker rejection. Aster decisions now build
  their own five-rung intent and use the shared authenticated broker route.
  The configured user, connection, environment, live/enabled state, four-symbol
  universe, dynamic-wallet plan and explicit 1–125 leverage are validated.
  ApeX's sizing and TP fields never enter the Aster intent. The signer retains
  authenticated venue sizing, collateral, position and contract-rule authority.
- Added a sized MARKET reduce-only exit to the broker → private signer route.
  It reads the selected account's actual one-way position and rejects the wrong
  direction, oversized quantities or pending entry orders. It reserves the
  close request durably, submits once, then verifies the specific venue order.
  It never changes leverage, cancels all orders, or cancels protective stops.
  New-entry flags may be off while CLOSE_POSITION remains permitted.
- Fixed worker transport timeouts/5xx and broker malformed/5xx response handling:
  uncertain submission is ambiguous, not rejected/submitted by default. Partial
  results retain the connection-specific in-flight lock. Response sanitization
  now preserves reconciliation-required, filled-size and reduce-only evidence.
- Broker integration tests inject signed worker requests into the real Fastify
  router; venue responses remain mocks. Exporting `build()` no longer boots an
  HTTP listener when the server is imported for testing; direct execution still
  starts the production service normally.
- These additions do **not** establish a complete autonomous close lifecycle:
  pending entry cancellation sequencing, durable campaign reconciliation and
  Guardian/Onyx directive-to-Aster-exit dispatch remain to be integrated. A close
  receipt alone is not proof the whole position is flat.
- Verified: 544 signer tests, 52 broker tests and broker typechecking passed on
  the local runtimes. Production Python 3.11 CI and deployed verification remain.
- The focused worker/decision/contract suite passed 60 tests. A broader worker
  suite was interrupted after 68 passes while a legacy test entered the worker
  DNS-retry sleep; this is not a full-worker-suite pass.

## 2026-09-24 read-path and database findings

### Order-ledger repair prepared; production not modified

- Added `20260924070204_restore_execution_order_ledgers.sql`, generated using
  the Supabase CLI. It restores the three persistence contracts without
  changing strategy flags, permissions, positions, or wallet balances.
- Signed-in clients receive owner-scoped SELECT only. Service writers retain
  intent transitions, duplicate intent/order keys are unique, and audit rows
  are append-only. New intent/order tables enforce connection/user ownership
  with composite foreign keys.
- Validated the migration twice in isolated in-memory PostgreSQL (PGlite
  0.3.14), then tested owner vs other-user reads, denied client/anonymous
  access, cross-owner insert rejection, duplicate reservations, transition
  replay, and audit immutability. Fixture writes roll back.
- Reproduce with `node scripts/test-execution-ledgers.mjs <PGlite module path>`.
  The SQL bootstrap/tests are for an isolated database only, never production.
- Fixed reconciliation's missing-ledger error handling: failed attribution or
  prior-position reads no longer become empty evidence that labels a bot
  position as manual. The failed connection cycle reports an explicit error
  instead of running its close sweep.
- Supabase project metadata identifies this as **Turtlebot v1**, created
  August 27, 2026. July migration history is absent; the incomplete-migration
  hypothesis is stronger, but historical order recovery remains unverified.
- Production apply is pending history/venue reconciliation. The CLI backup
  listing requires authentication unavailable in this session; no backup was
  restored, no production DDL was applied, and no trading switch was changed.
- Focused verification: 68 Aster signer tests and 18 TypeScript tests passed.
  Targeted strict TypeScript checking of the attribution helper/tests passed.
  Native PostgreSQL could not start under the sandbox's shared-memory
  restrictions; embedded PostgreSQL executed the SQL tests successfully.

- Added HMAC-authenticated, owned-connection `/v1/aster/equity`,
  `/v1/aster/positions`, and `/v1/aster/fills` read routes. Malformed venue
  responses fail instead of presenting zero balances or a flat account.
- Worker equity reads now dispatch Aster to its signer. Position reconciliation
  and fill-ingestion jobs include Aster without changing ApeX's direct reader.
- Fill reads cover BTC/ETH/SOL/XRP with complete bounded windows; saturated
  responses are split, failures do not advance the cursor, and IDs include the
  symbol. Hedge-mode fills and non-USDT fees are explicitly unsupported by the
  existing one-way FIFO matcher rather than silently misattributed.
- Accept the stored `production` environment as the Aster `mainnet` alias.
- Read-only SQL on the project referenced by both `supabase/config.toml` and
  `supabase/.temp/project-ref` (`sthdmulczzebfcmihhca`) found no public
  `order_intents`, `orders`, or `order_audit` tables, despite two verified live
  exchange connections. The intent enum and position/fill tables exist.
  No schema or records were changed. This is not proof that the missing
  historical order state can safely be replaced with empty tables.
- Follow-up migration-history check found neither original July order-ledger
  migration (`20260714150000`, `20260715155935`) recorded in this project.
  September history instead includes a series of targeted schema restorations,
  including `restore_internal_live_canary` and `restore_live_fill_ledger`.
  This supports an incomplete schema restoration as a hypothesis; it does not
  establish when tables disappeared or whether historical orders are recoverable.
  The owner confirms Aster uses the same backend as ApeX. A separate Aster
  database is not the intended repair.
- Railway's TurtleBot signer source is `Onixus-AI/turtle-bot-dashboard`, main,
  `/signer`. Its connected tool redacts environment values, so the runtime
  Supabase URL has **not** been independently confirmed against this checkout.
  Confirm the active database/restore history before applying ledger repairs.

## Added and wired through broker → signer

- `POST /v1/aster/entry-status`: reads a selected campaign rung from the venue.
- `POST /v1/aster/cancel-entry`: cancels only that rung's remaining LIMIT entry.

Public request fields: `connection_id`, `client_order_id` (the original
campaign/decision key), `symbol` (`BTC-USDT`, `ETH-USDT`, `SOL-USDT`, or
`XRP-USDT`), and `rung` (1–5). The public broker derives `user_id` from the
verified JWT and looks up the owned Aster mainnet connection with caller RLS.
The signer independently checks ownership, requires HMAC authentication, and
derives the exact entry ID from user + connection + campaign key + rung.
No arbitrary venue order ID, secret, or user ID is accepted from the browser.

Read/cancel is independent of the new-entry automation flag, so pausing new
entries does not prevent observation or cancellation. Cancellation still
requires verified trading permission. Neither route opens or closes a
position, alters leverage, cancels the linked stop, or calls cancel-all.

An entry can fill between lookup and cancellation. The code rereads after
DELETE and reports executed quantity. Timeout, malformed confirmation, or
failed reread is not treated as successful cancellation. No mutation is
retried automatically. A missing order is not evidence of zero exposure:
the official API can omit old, unfilled canceled orders after seven days.

These endpoints are **entry-order observation and cancellation**, not full
position reconciliation. They do not yet persist a reconciled campaign state
or verify all remaining protective orders after an exit.

## Still required before live automation

1. Leverage choice resolved on 2026-09-24: the owner approved a 125x Aster
   ceiling. Local broker validation and signer campaign/transport validation
   now enforce that ceiling; authenticated symbol/notional brackets can lower
   it. This is not a default leverage or a change to existing positions.
   ApeX remains capped at 100x. UI integration and deployment remain
   incomplete; this does not establish live readiness or a supported 200x route.
2. Deploy and verify the read/reconciliation and pending-entry cancellation
   paths described in the follow-up above. Their unit/SQL/CI checks pass, but
   they have not been validated against the production account.
3. Connect the management controls in the UI and verify signed-in behavior.
4. Pass authoritative Python 3.11 signer CI and deploy the reviewed changes.
5. Verify the actual account's deposit, permission, collateral and symbol
   constraints. Local mocks do not establish funded account readiness.
6. The owner must review and arm their intended live configuration themselves.

## Tests

- Signer tests cover authenticated routes, separate wallet identities,
  malformed data, unknown responses, partial fills, fill/cancel races,
  protective-order preservation, and credential cleanup.
- Broker injection tests exercise identity forwarding, ownership, venue and
  permission rejection, strict request schemas and timeout uncertainty.
- No production request, order, cancellation, close or flag change was made.

Reference: [official Aster V3 API](https://github.com/asterdex/api-docs/blob/master/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md).
