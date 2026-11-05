# Owner secret-provisioning runbook — Phase B.2

Never paste any of the values below into Lovable chat, into a commit,
into a README, or into a migration. Generate locally, paste into the
service dashboard, verify without printing, done.

The four `APEX_MAINNET_*` execution flags remain `false` at the end of
this runbook. The signer does not read `APEX_MAINNET_READS_ENABLED` —
reads are always-enabled by design (see `signer/app/operations.py`).
Only the broker enforces that flag, and it is provisioned once at broker
deploy time, not flipped during activation.

## Group A — Railway service `apex-signer`

Screen: Railway → project → service `apex-signer` → **Variables**.

Variable names below are the exact keys read by `signer/app/*.py`. Do not
substitute synonyms: `SIGNER_ALLOWED_SKEW_SECONDS` (not
`SIGNER_MAX_CLOCK_SKEW_SECONDS`) and `APEX_MASTER_WRAPPING_KEY_V*` (not
`SIGNER_ENVELOPE_MASTER_KEY_V*`) are the canonical names — the previous
runbook used stale names that no code reads.

| Name                                | Where it exists    | Format / length              | Read by                                    | How to generate locally (do not paste into chat)                            |
|-------------------------------------|--------------------|------------------------------|--------------------------------------------|-----------------------------------------------------------------------------|
| `SIGNER_SHARED_SECRET`              | Railway + Supabase (identical) | 64 hex chars     | `app/security.py::_shared_secret`          | `openssl rand -hex 32`                                                      |
| `SIGNER_ALLOWED_SKEW_SECONDS`       | Railway only       | Integer (default `30`)       | `app/security.py::_skew_seconds`           | Type `30`.                                                                    |
| `APEX_MASTER_WRAPPING_KEY_V1`       | Railway only       | Base64, exactly 32 raw bytes | `app/crypto.py::_wrapping_key`             | `openssl rand -base64 32`                                                   |
| `APEX_MASTER_WRAPPING_KEY_ACTIVE`   | Railway only       | Integer, start at `1`        | `app/crypto.py::_active_version`           | Type `1`.                                                                    |
| `TURTLE_CREDENTIAL_ENCRYPTION_KEY`  | Railway + Supabase (identical) | UTF-8 string, ≥32 bytes | `app/exchange_creds.py::_aead` (signer) and Edge Function `exchange-credentials` (Supabase) | Same value already provisioned in Supabase Edge Function Secrets. Copy it into Railway; never rotate one side without the other. |
| `SUPABASE_URL`                      | Railway only       | https URL                    | `app/db.py` (worker-ingest base) + service-role client | Copy from project settings.                                          |
| `WORKER_INGEST_SHARED_SECRET`       | Railway + Supabase (identical) | ≥32 chars      | `worker_ingest_client.WorkerIngestClient`  | Same value already provisioned in Supabase Edge Function Secrets. Copy it into Railway. |
| `WORKER_INGEST_WORKER_ID`           | Railway only       | short string, ≤64 chars      | `worker_ingest_client.WorkerIngestClient`  | Type `railway-turtlebot-primary` (must match a row in `worker_registry`).    |
| `WORKER_INGEST_KEY_VERSION`         | Railway only       | short string                 | `worker_ingest_client.WorkerIngestClient`  | Type `v1`.                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`         | Railway only, **optional in Phase B.2** | JWT | `app/db.py::_client` — lazy, only used by execution-flag-gated paths (`order_intents`, `apex_execution_credentials`). Read handlers do NOT require it. | Only paste when you enable one of the `APEX_MAINNET_*` execution flags. |
| `APEX_MAINNET_SIGNER_ENABLED`       | **Server-side flag, Railway only** | `true` / `false` | `app/main.py::_signer_enabled`             | Leave `false`. Phase B.2 does not enable it.                                 |
| `APEX_MAINNET_CANARY_ENABLED`       | **Server-side flag, Railway only** | `true` / `false` | `app/main.py::_canary_enabled`             | Leave `false`.                                                               |
| `APEX_MAINNET_CAPITAL_ENABLED`      | **Server-side flag, Railway only** | `true` / `false` | `app/main.py::_capital_moves_enabled`      | Enables only same-account Funding ↔ Perps allocation; never external withdrawal. |

Read-only endpoints (`/v1/verify-credentials`, `/v1/read-account`) reach the
encrypted `exchange_credentials` rows through the signed `worker-ingest` edge
function using `WORKER_INGEST_SHARED_SECRET`. They never call the Supabase
Data API directly and do not require `SUPABASE_SERVICE_ROLE_KEY` on the
signer host. Plaintext credentials never leave the signer process: the
edge function returns only encrypted columns; decryption happens locally
with `TURTLE_CREDENTIAL_ENCRYPTION_KEY`.


## Group B — Supabase Edge Function `execution-broker`

Screen: Supabase → project → Edge Functions → `execution-broker` →
**Secrets** (or `supabase secrets set --env-file ...`, values never
printed on screen).

| Name                    | Where it exists                     | Format                              | Notes                                                                                          |
|-------------------------|--------------------------------------|--------------------------------------|-------------------------------------------------------------------------------------------------|
| `SIGNER_BASE_URL`       | Supabase only                        | https URL, private hostname         | Railway private-network URL of `apex-signer`. See `TOPOLOGY.md` for the constraint.             |
| `SIGNER_SHARED_SECRET`  | **Identical on Railway and Supabase**| 64 hex chars                        | Paste the same value produced for Group A. Do not regenerate.                                   |
| `SIGNER_TIMEOUT_MS`     | Supabase only                        | Integer ms                          | Type `10000`.                                                                                    |

## Group C — ApeX credential onboarding

Owners onboard through TurtleBot's authenticated UI — never through the
signer directly, never by editing the database, never by pasting API
secrets into Lovable chat. The wallet sign step happens inside the
browser; the derived STARK material is envelope-encrypted server-side.

There is no owner-editable ApeX secret in Railway or Supabase.

## Verifying a secret is saved without revealing it

Railway:
```
railway variables --service apex-signer --kv | awk -F= '{print $1}' | sort
```
Supabase:
```
supabase secrets list --project-ref <ref>
```
Both list **names only**. If a name is missing, re-add it. Never `echo`
the value.

## Rotation

- `SIGNER_SHARED_SECRET`: generate a new value, paste to Railway and
  Supabase in the same maintenance window, redeploy both, watch for zero
  `INVALID_HMAC_SIGNATURE` responses.
- `APEX_MASTER_WRAPPING_KEY_V*`: add `V2`, set
  `APEX_MASTER_WRAPPING_KEY_ACTIVE=2`, re-encrypt every stored bundle
  through the maintenance job, then delete `V1`.
- `SUPABASE_SERVICE_ROLE_KEY`: rotate in Supabase, paste to Railway,
  redeploy signer, then revoke the old key.


## Rollback / revocation

- Immediate stop of private reads: no `APEX_MAINNET_READS_ENABLED` gate
  is read by the signer today; reads are refused until the read handler
  and its own gate ship (see `SDK_INVESTIGATION.md`). Until then only
  `/healthz`, `/v1/onboard`, `/v1/sign-order`, and `/v1/revoke` exist.

- Immediate stop of the signer: set `APEX_MAINNET_SIGNER_ENABLED=false`
  in Railway → redeploy. Every sign call returns `SIGNER_DISABLED`.
- Compromised HMAC: rotate `SIGNER_SHARED_SECRET` per §above; old caller
  is invalidated instantly.
- Credential revocation: call `/v1/revoke` from the broker with the
  affected `credential_id`. The row is marked `revoked_at=now(),
  active=false`; subsequent signs fail immediately.
- Full teardown: delete the Railway service `apex-signer`. Every write
  path is unreachable.

---

# Live signing verification — exact steps (added 2026-07-17)

Status at time of writing: **signer code complete and green; NOT deployed,
NOT enabled, NO order ever signed against a live credential.**

`OPERATION_ENABLED["SIGN_ORDER"]` is `False` in `app/operations.py`. That flag
is the sole authority — the env flags below are necessary but NOT sufficient.

## 0. Preconditions (owner-only; the signer cannot self-provision)

| Item | Where | Notes |
|---|---|---|
| `WORKER_INGEST_SHARED_SECRET` | Railway signer service | Distinct from every other secret |
| `APEX_MASTER_WRAPPING_KEY_V1` | Railway signer service | base64, exactly 32 bytes |
| `APEX_MASTER_WRAPPING_KEY_ACTIVE` | Railway signer service | `1` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Railway signer service | Service-role stays ONLY here |
| `APEX_IDEMPOTENCY_SALT` | Railway signer service | Any stable random string |

Never set these in the worker or the frontend. The worker refuses to boot into
paper mode if a service-role credential is present — that guard is deliberate.

## 1. Authoritative CI must be green

```sh
# GitHub Actions -> signer-ci -> "signer tests (Python 3.11 — authoritative)"
```
A pass on any other interpreter is **secondary evidence only**. The lockfile
pins 3.11 and the zkLink bindings are compiled artifacts.

## 2. Deploy the signer container (no flags yet)

```sh
# Railway -> turtlebot-signer -> deploy
curl -fsS https://<signer-host>/healthz     # -> {"ok": true}
```
Expect `/v1/*` to reject everything: flags are off. That is correct.

## 3. Non-order connectivity verification FIRST

Do this before any signing. It proves auth, transport, and credential
plumbing without touching an order.

```sh
# Signed request (HMAC + timestamp + nonce) -> VERIFY_CREDENTIALS, READ_ACCOUNT
# Both are already enabled in OPERATION_ENABLED and are read-only.
```
Confirm: `VERIFY_CREDENTIALS` returns sanitized metadata only, and
`READ_ACCOUNT` returns a readable ApeX mainnet balance. **If the balance is
not readable, stop.** Everything downstream assumes it.

### Single-command readiness verification (Railway SSH)

Run inside the signer container. This is the one command the owner runs:

```sh
railway ssh --service apex-signer -- \
  python -m scripts.verify_readiness \
    --user-id <USER_UUID> --connection-id <CONNECTION_UUID>
```

The script (`signer/scripts/verify_readiness.py`) refuses to run unless
every write operation in `OPERATION_ENABLED` is `False` AND both
`APEX_MAINNET_SIGNER_ENABLED` and `APEX_MAINNET_CANARY_ENABLED` are
`false`. It reads `SIGNER_SHARED_SECRET` from the container environment,
generates HMAC timestamp/nonce internally, and calls
`http://127.0.0.1:8080` for `/healthz`, `/v1/verify-credentials`, and
`/v1/read-account`. Output is a sanitized JSON report — no secrets, no
signatures, no encrypted fields, no request headers. Exit 0 = ready;
1 = precondition failed; 2 = signer/HTTP failure.

## 4. Onboard a credential (derives the zk key; places no order)

The wallet signs the canonical message client-side. The signer never sees an
Ethereum private key — the EIP-191 signature IS the zk seed.

```sh
APEX_MAINNET_SIGNER_ENABLED=true    # build + sign only. NOT submit.
```
Then POST `/v1/onboard` with `{user_id, exchange_connection_id, wallet_address,
environment: "mainnet", signature}`.

Verify in the database:
```sql
select id, environment, credential_fingerprint, encryption_key_version, active
from public.apex_execution_credentials where active is true;
-- encrypted_credentials MUST be opaque. If you can read a seed, STOP.
select event, detail from public.apex_credential_audit order by created_at desc limit 5;
-- metadata only; no seeds, no signatures.
```
`apex_execution_credentials_one_active` enforces one active credential per
(user, wallet, connection, environment). A second onboard fails closed.

## 5. First live SIGNING verification — dry run, no submission

Flip `OPERATION_ENABLED["SIGN_ORDER"] = True` in `app/operations.py` and
redeploy. **Leave `APEX_MAINNET_CANARY_ENABLED=false`.**

Create an `order_intents` row in state `confirmed`, then POST `/v1/sign-order`
with `is_live: false`.

Expected — this is the whole verification:
```
HTTP 200  {"status": "signed_not_submitted", "reject_reason": "DRY_RUN_NOT_SUBMITTED"}
```
```sql
select state, state_reason from public.order_intents where client_order_id = '<coid>';
-- rejected / DRY_RUN_NOT_SUBMITTED    <- terminal dry run
select phase, reject_reason, sanitized_response from public.order_audit
 where idempotency_key = '<coid>';
-- rejected / DRY_RUN_NOT_SUBMITTED / submitted_to_venue=false, signature_discarded=true
```
The order was signed with real zkLink material and the signature was
discarded. Nothing reached ApeX.

**This is NOT a venue rejection.** Exclude `DRY_RUN_NOT_SUBMITTED` from
venue-rejection metrics and alerting via `order_store.is_venue_rejection()` —
the single predicate. Do not re-derive that test per call site.

## 6. Revocation drill (do this BEFORE trusting anything with money)

```sh
# POST /v1/revoke {"credential_id": "<id>"}   -> {"status": "revoked", ...}
# Repeat /v1/sign-order -> HTTP 403 CREDENTIAL_REVOKED_OR_MISSING
```
Revocation is enforced in the query (`active=true AND revoked_at IS NULL`), not
by a caller's `if`. Revoking twice returns `already_revoked` — idempotent.

## 7. STOP HERE

Submission is deliberately **not implemented**. `APEX_MAINNET_CANARY_ENABLED`
gates a path that does not yet exist. Do not enable it expecting an order.

## Blockers to a first real order (unchanged, owner-only)

1. **G33** — `original_first_entry_target` undefined. No ratified exit rule.
2. **Allocation** — no capital figure exists anywhere.
3. **Leverage** — never specified.
4. **Mainnet ApeX credential with trade permission** — the only row today is
   `apex_omni / test / pending_verification / permissions_verified=false`.
5. **Stage 0.5 reversal** — the worker has no order path, by design, with tests
   enforcing it. Reconnecting it is an explicit owner decision.
6. **Observation evidence** — the observational path has never emitted an event.

## Rollback

```sh
APEX_MAINNET_SIGNER_ENABLED=false   # immediate: /v1/onboard, /v1/sign-order -> 403
# then, for defence in depth:
OPERATION_ENABLED["SIGN_ORDER"] = False   # code-level authority
# POST /v1/revoke for every active credential -> stored material unusable
```
