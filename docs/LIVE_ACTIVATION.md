# LIVE ACTIVATION — Owner Ceremony Checklist

**Status:** Internal manual canary only. Public/community live trading and
autonomous execution remain disabled. The owner may temporarily enable the
signer and canary gates only after completing this ceremony. Every gate is
owner-only — never automate or delegate it to CI.

The internal canary route is deliberately narrower than the autonomous worker:
four symbols (`BTC-USDT`, `ETH-USDT`, `SOL-USDT`, `XRP-USDT`), MARKET entry
orders only, $100 maximum authoritative venue notional, 5x maximum leverage,
mandatory signer-side protection, and an explicit review/confirm step.

## 0. Preconditions (must all be green)

- [ ] All parity tests pass: `bunx vitest run` and `pytest`.
  Confirms shared JSON is loading on both sides and DEBT-01/02/03/04/05/06
  are closed (see `docs/MAINNET_PARITY.md`).
- [ ] `paper_live_shadow_ledger` table exists and RLS is enabled.
- [ ] Broker `/readyz` returns `{ ok:true, signer:'ok' }` on Railway.
- [ ] `python -m scripts.verify_readiness` inside the signer container
  returns `overall=ready` (only reachable on Railway SSH; do NOT run from a
  laptop, do NOT pipe output into chat).

## 1. Pilot funding envelope

Values live in `shared/mainnet_parity_constants.json → pilot.*`.
The broker `translate_directive` clamps every intent to these:

- `allocation_reserve_floor_usd` — never on-desk.
- `allocation_ceiling_usd` — hard cap on the working allocation.
- `max_leverage` — hard cap on effective leverage.

Confirm the current on-desk balance is ≤ `reserve_floor + ceiling`. If it
is more, transfer the excess out BEFORE activation.

## 2. Dry-wire the execution path

With every flag still `false`:

1. From the owner console, call `POST /v1/directives/translate` (broker) with
   each directive type in `enums.directive_types`:
   `cancel_unfilled_rungs`, `close_position`, `promote_runner`,
   `cancel_fixed_tp`, `set_breakeven_stop`, `repair_stop`.
2. For each response, verify:
   - `dry_run: true`
   - `effective_leverage <= pilot.max_leverage`
   - `allocation_usd <= pilot.allocation_ceiling_usd`
   - notes include the clamp when requested leverage exceeds the ceiling
3. No response should ever include a signer artifact, order id, or venue
   payload — dry-run must not touch the signer.

## 3. Exchange-side stop verification (paper simulate)

`shared/mainnet_parity_constants.json → stop_verification.paper_simulate=true`.
Confirm the worker is emitting `STOP_VERIFY_OK` telemetry every cycle for
every open paper position, and `STOP_VERIFY_WOULD_REPAIR` for at least one
synthetic drift test. If the paper cycle NEVER emits the WOULD_REPAIR event,
the code path is not being exercised — do not go live.

## 3.5. Credential onboarding (wallet signature — never an env var)

Live signing material is derived from a wallet signature over the canonical
ApeX Omni onboarding message. The seed is **never** placed in an env var,
never persisted in plaintext, and never returned to the browser.

1. Open `/exchanges` as owner/admin, select the ApeX Omni connection.
2. Click **Activate live signing** → connect wallet → sign the ApeX Omni
   onboarding message for the connection's environment.
3. Confirm the returned credential fingerprint matches the row inserted
   into `apex_execution_credentials` (single active bundle per user + wallet
   + connection + environment).
4. Re-onboarding is idempotent: the prior active bundle is revoked with an
   audit row before the new bundle is inserted.

`docs/SIGNER_ENV.md` is the authoritative variable inventory — cross-check
that every listed variable is provisioned on the correct Railway service
before flipping the flags below.


## 4. Shadow-mode bake

- [ ] Confirm the paper engine has been running for ≥ 24h against the same
  symbol set the live worker will use.
- [ ] Visit `/shadow` — the table should populate with `paper_only` rows.
- [ ] Zero rows with `comparison_status='divergent'` for the last 24h
  (paper-only rows count as in-line-by-definition — nothing to compare yet).

## 5. Activation sequence (in order, owner-only, one step per worker cycle)

Reads are always-enabled by design on the signer — every entry in
`signer/app/operations.py::OPERATION_ENABLED` for `VERIFY_CREDENTIALS`
and `READ_*` is `True` on deploy, and the execution paths are gated
solely by `APEX_MAINNET_SIGNER_ENABLED` and `APEX_MAINNET_CANARY_ENABLED`
in `signer/app/main.py`. There is no `APEX_MAINNET_READS_ENABLED` env
var on the signer to flip. Do NOT hunt for one. Screenshot `/ops`
before and after every step below.

1. **Credential onboarding via wallet signature** — complete section 3.5
   for the canary connection. Confirm a single active row in
   `apex_execution_credentials` with the expected fingerprint. Nothing
   is enabled by this step; onboarding only stores encrypted material.
2. **`APEX_MAINNET_SIGNER_ENABLED=true`** on the `apex-signer` Railway
   service (redeploy). Signer now accepts build/sign/cancel/reconcile;
   order emission is still blocked by the canary gate.
3. **One worker cycle + verify.** Confirm:
   - `/readyz` on the broker returns `{ ok:true, signer:'ok' }`.
   - Signer `/v1/read-account` (called via broker preflight) returns a
     sanitized balance (no keys, no seeds, no signatures in the payload
     or logs).
   - Worker heartbeat lands with `signer_ok=true`.
4. **`APEX_MAINNET_CANARY_ENABLED=true`** on the `apex-signer` Railway
   service (redeploy). Order-emitting ops (`CREATE_ORDER`,
   `CLOSE_POSITION`, `CLOSE_ALL_POSITIONS`) are now buildable; no live
   emission happens until step 5.
5. **Keep autonomous execution off.** Set `LIVE_TRADING_ENABLED=false` on
   the Railway worker and `APEX_MAINNET_AUTOMATION_ENABLED=false` on the
   Railway broker. Internal testing uses only the reviewed owner ticket;
   the worker must remain paper-only.

6. **`is_live=true` on the ONE canary connection** in the app admin
   (`/exchanges` → canary connection → toggle). Never flip multiple
   connections in the same ceremony.
7. **Kill-switch drill.** From the owner UI, trigger the kill switch on
   the canary connection and confirm every subsequent broker call
   returns `EXECUTION_HALTED`. Re-arm and confirm the worker resumes on
   the next cycle. A failed drill halts the ceremony.
8. **`/shadow` watch — first hour.** Every live decision should land
   with `comparison_status ∈ {in_line, live_only}`. A single `divergent`
   row halts activation: flip step 6 back to `is_live=false` and open a
   debt entry before re-attempting.

### Go-live checklist (env vars, corrected)

The paper→live switch is spread across three Railway services. There is
no `MODE` variable on any of them.

| Service | Variable | Value to go live |
| --- | --- | --- |
| `worker` (bot_worker.py) | `LIVE_TRADING_ENABLED` | `false` |
| `apex-signer` | `APEX_MAINNET_SIGNER_ENABLED` | `true` |
| `apex-signer` | `APEX_MAINNET_CANARY_ENABLED` | `true` |
| `execution-broker` | `APEX_MAINNET_SIGNER_ENABLED` | `true` |
| `execution-broker` | `APEX_MAINNET_CANARY_ENABLED` | `true` |
| `execution-broker` | `APEX_MAINNET_AUTOMATION_ENABLED` | `false` |

The signer and broker signer/canary flags must agree for the manual canary.
Automation stays false during a manual-only canary. For an approved automated
internal rehearsal, first provision `TURTLE_BROKER_BASE_URL` and
`BROKER_SIGNING_SECRET` on the worker, provision the matching value as
`WORKER_ORDER_SHARED_SECRET` on the broker, and provision the same
`TURTLE_BROKER_BASE_URL` and `BROKER_SIGNING_SECRET` on Vercel for the
reduce-only TP council. Confirm the capability probe is ready, then set the
broker automation flag and worker live flag to true in the same controlled
activation window.

## 6. Post-activation guardrails

- `/ops` — every worker heartbeat green.
- `/shadow` — rolling 24h divergence rate < 1 %.
- `paper_live_shadow_ledger` — no unresolved `divergent` rows > 1h old.
- `MAINNET_PARITY.md` — no new 🔴 rows.

If any of those regress, revert the step that preceded the regression
and file a debt entry BEFORE re-attempting.
