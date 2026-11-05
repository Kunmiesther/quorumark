# Onboarding & Multi-Tenant Security Standard

**Status:** enforceable standard. Every future change touching onboarding,
credentials, signer trust, or per-user isolation MUST comply with — and
update — this document. No prose "done". No parity IOUs. No fail-open path.

The bar is wallet-grade (Phantom / MetaMask). If a control in a self-custody
wallet would prevent this class of failure, TurtleBot must match it.

---

## 1. Onboarding flow (per user, self-serve, no operator)

Each user completes the ceremony end-to-end from the browser. No partial
activation: a user is either fully onboarded (own wallet + own sealed ApeX
credential + own `is_live` flag) or fully off. There is no shared credential
and no operator-onboarded account.

| # | Step | Surface | Owner-verifiable check |
|---|------|---------|------------------------|
| 1 | Sign in (Supabase Auth: email/password or Google) | `/auth` | JWT issued; `auth.uid()` = the user's id from now on. |
| 2 | Connect ApeX Omni exchange row | `/exchanges` → `exchange_connections` insert | Row is written under RLS `auth.uid() = user_id`; another user cannot see it. |
| 3 | Activate Live Signing modal | `ApexActivateSigning.tsx` | Modal renders only the caller's own `connection_id`. |
| 4 | Connect wallet (MetaMask/Phantom EVM) via extension or in-app browser | `wallet_connection_challenges` + wallet signer | WalletConnect project id is NOT required. |
| 5 | Wallet signs the human-readable onboarding message via EIP-191 `personal_sign` | Browser | Message is `ApeX Omni {Mainnet|Testnet}\n\n...\n\nWallet: 0x…`. Never blind hex. |
| 6 | Signature POSTed to broker `/v1/onboard` | Public Railway broker | Broker verifies the caller's Supabase JWT via JWKS; ownership of `connection_id` confirmed via RLS-scoped read (no service-role key). |
| 7 | Broker forwards HMAC-signed request to private signer `/v1/onboard` (includes `caller_jwt` inside the HMAC-covered body) | Railway private network | Signer verifies HMAC + timestamp + nonce; recovers wallet address from EIP-191 and MUST match `wallet_address` — subcode surfaces if mismatch. |
| 8 | Signer derives zkLink STARK material (`seeds`, `l2_key`, `pub_key_hash`) | Signer process only | `seeds` lives only on the stack frame; envelope-encrypted immediately and scrubbed. |
| 9 | Signer envelope-encrypts the bundle (per-bundle AES-256-GCM DEK, DEK wrapped by `APEX_MASTER_WRAPPING_KEY_V{active}`, AAD = `user_id|wallet|environment`) | Signer process only | AAD binding makes a ciphertext untransportable across users, wallets, or environments. |
| 10 | Signer persists row into `apex_execution_credentials` as the caller (RLS `auth.uid() = user_id`), writes an `apex_credential_audit` row | Supabase via caller JWT | Unique partial index enforces one active bundle per `(user, wallet, connection, environment)`; re-onboarding follows revoke-and-replace. |
| 11 | Signer returns `credential_fingerprint` (SHA-256 of the l2 pub-key hash) to the UI | Browser sees fingerprint | Fingerprint proves activation without ever surfacing key material. |
| 12 | Fund the ApeX account, then set `is_live=true` on the user's own connection | User-scoped write, RLS-gated | Live status is per-connection and per-user — never global. |

### Fail states (what the user sees, why)

Every failure has a stable, non-secret subcode. Copy in the UI is human;
telemetry keeps the code.

| Fail state | Subcode(s) | Meaning |
|------------|------------|---------|
| Not signed in | `UNAUTHORIZED` / redirect to `/auth` | No JWT to derive `auth.uid()`. |
| Wallet signed for the wrong environment | `SIGNATURE_ADDRESS_MISMATCH:recovered_ends_XXXXXX_expected_ends_YYYYYY` | Testnet vs Mainnet header differs — recovered address differs. |
| Wallet returned a non-ECDSA blob (smart wallet / EIP-1271) | `INVALID_SIGNATURE_LENGTH_N` | ApeX zk derivation requires the raw `personal_sign` output. |
| HMAC secret missing on broker/signer | `MISSING_ENV:SIGNER_SHARED_SECRET` (boot); requests 401 `MISSING_AUTH_HEADERS` | Service refuses to start / accept requests. Fail-closed. |
| Wrapping key missing | `ENCRYPTION_UNCONFIGURED:MISSING_WRAPPING_KEY_V1` | Onboarding refuses. Nothing is ever persisted unencrypted. |
| RLS blocks write | `CREDENTIAL_INSERT_FAILED` | Only ever seen when the caller_jwt does not match `body.user_id`. |
| Signer disabled | 403 `SIGNER_DISABLED` | `APEX_MAINNET_SIGNER_ENABLED=false`. Every non-read operation refuses. |
| User's connection kill-switch tripped | 423 `EXECUTION_HALTED` | Per-user, per-connection halt via `public.is_execution_halted` RPC. |

### Post-activation invariants

- `is_live` is per `exchange_connections` row → per user. One user going live
  does NOT arm another user.
- Kill switches are per user × per connection (`kill_switches` table + the
  RPC). There is no UI or code path that lets a user trip a switch for
  anyone else.
- Global `APEX_MAINNET_*` flags on Railway are **operator-level** last-line
  brakes for the whole product. Owner may leave them off; individual users
  can still be off through their own `is_live=false` even when the operator
  flag is on. Owner may cut them off to halt the whole platform.

---

## 2. Security guarantees

- **Seed / zkLink material never leaves the signer process.** Not in the
  repo, database, logs, chat, or any response body. `sanitize_response`
  drops everything that is not in a small allowlist.
- **REST credentials at rest are envelope-encrypted.** Per-bundle DEK, DEK
  wrapped by the master wrapping key with AAD bound to
  `user_id|wallet|environment`. A ciphertext cannot be moved between users,
  wallets, or environments even if the DB is stolen.
- **The user always signs an explicit, human-readable message** — never a
  blind hex challenge. `ApeX Omni {Mainnet|Testnet}\n\n…\n\nWallet: 0x…`.
- **Fail-closed everywhere.** Missing wrapping key → onboarding refuses.
  Missing HMAC secret → signer 500s and boot fails. Flag off → operation
  refuses. RLS missing → PostgREST denies by default.
- **Per-user isolation via RLS.** Every user-owned table has RLS enabled
  and its SELECT/UPDATE policies scoped to `auth.uid() = user_id`. Section
  4 below is the enforceable coverage table.
- **Secret hygiene.** Fastify logger `redact` covers `authorization`,
  `x-signer-signature`, cookies, `SIGNER_SHARED_SECRET`,
  `SUPABASE_PUBLISHABLE_KEY`, `apiKey`, `apiSecret`, `passphrase`,
  `omniSeed`. Python signer disables `uvicorn.access` logging entirely.
  `orders_v3` has no logger imported. `execution` never persists audit
  directly.

---

## 3. Key management

| Key | Where | Rotation | Loss vs. Leak |
|-----|-------|----------|---------------|
| `APEX_MASTER_WRAPPING_KEY_V{N}` | Railway signer env only. NEVER anywhere else. | Provision `APEX_MASTER_WRAPPING_KEY_V{N+1}`, bump `APEX_MASTER_WRAPPING_KEY_ACTIVE`. Old versions stay decryptable until every bundle is re-wrapped and revoked. | **Leak:** rotate immediately, force every user to re-onboard, revoke all outstanding credentials. **Loss:** all encrypted bundles unrecoverable; every user must re-onboard. |
| `SIGNER_SHARED_SECRET` | Railway broker + Railway signer envs. | Rotate the pair atomically (deploy broker with new value; signer picks up on restart). | Leak → any actor who can reach the signer hostname can call it; combined with public exposure this is total compromise. Rotate + lock down egress immediately. |
| `BROKER_SIGNING_SECRET` / `WORKER_ORDER_SHARED_SECRET` | Same automation HMAC value under a worker-side name and Railway-broker-side name. Never on the signer or browser. | Rotate the pair atomically and redeploy worker + broker. | Leak → an attacker could impersonate the worker at the automation route; broker flags, signer checks, nonce/timestamp replay defense, and kill switch remain independent controls. Rotate immediately. |
| `TURTLE_CREDENTIAL_ENCRYPTION_KEY` | Supabase edge fn env only. Encrypts the legacy REST credential columns. | Same as any secret rotation. | Leak → REST creds decrypt-able; combined with DB access = compromise of REST API keys only (never zk seeds). Rotate + user re-enters REST keys. |
| `WORKER_INGEST_SHARED_SECRET` | Worker + `worker-ingest` edge fn envs. | Rotate the pair. | Leak → attacker could POST fake worker heartbeats/ingest rows. HMAC + nonce + timestamp still block replay. |
| Supabase JWKS (JWT verification) | Supabase-managed. | Supabase-managed. | Not a shared secret — public key verification. |

Wrapping-key generation:
```sh
python -c "import base64,os; print(base64.b64encode(os.urandom(32)).decode())"
```
Paste into Railway signer env under the versioned name (`_V1`, `_V2`, …).
Never paste into chat, tickets, or the repo.

---

## 4. Multi-tenant RLS coverage table (credential & user-state surfaces)

All tables carry RLS = ON (verified). The tables below are the ones an
attacker would target for cross-user access; every one is owner-scoped.

| Table | Policies |
|-------|----------|
| `apex_execution_credentials` | SELECT/INSERT/UPDATE `auth.uid() = user_id`; DELETE `false` (no client deletes; revoke = update). |
| `apex_credential_audit` | SELECT/INSERT `auth.uid() = user_id`. |
| `apex_onboarding_challenges` | SELECT/INSERT `auth.uid() = user_id`; INSERT WITH CHECK enforces unconsumed. |
| `exchange_connections` | SELECT `auth.uid() = user_id`. Writes via edge function. |
| `exchange_credentials` (legacy REST) | SELECT `auth.uid() = user_id`; INSERT/UPDATE/DELETE `false` (writes only via `exchange-credentials` edge fn with service role). |
| `wallet_connections` | SELECT/INSERT/UPDATE/DELETE `auth.uid() = user_id`. |
| `wallet_connection_challenges` | SELECT/INSERT/UPDATE/DELETE `auth.uid() = user_id`. |
| `profiles`, `subscriptions`, `user_roles`, `user_strategy`, `user_strategy_toggles`, `user_trading_limits`, `user_turtle_progress`, `strategy_state`, `risk_capital_allocations`, `paper_wallets`, `paper_positions`, `paper_trades`, `paper_authorizations`, `paper_order_intents`, `paper_execution_slots`, `bills`, `bill_allocations`, `bill_withdrawal_links`, `life_obligations`, `life_categories`, `earnings_allocations`, `wallet_activation_events`, `connection_audit_events`, `order_intents`, `orders`, `positions`, `trades`, `point_ledger`, `point_awards`, `kill_switches`, `collectible_notify_prefs`, `scout_preferences`, `scout_corrections`, `notifications`, `fusion_lead_requests`, `waitlist_signups` | Owner-scoped via `auth.uid()`. Verified in `pg_policies`. |
| Ops/telemetry (`bot_events`, `bot_heartbeat`, `bot_status_events`, `worker_heartbeats`, `worker_ingest_nonces`, `worker_registry`, `ops_events`, `ops_health_snapshots`, `margin_policy_events`, `venue_capabilities`, `venue_capability_audit`, `apex_credential_audit`, `paper_engine_*`, `paper_tick_leases`, `bydfi_verified_universe`, `paper_test_symbols`, `paper_symbol_pods`, `milestone_definitions`, `scout_universe_snapshots`, `scout_signal_state`, `scout_signals`, `scout_scans`, `scout_rotation_state`, `scout_evidence`, `scout_outcomes`, `scout_state_transitions`, `scout_symbol_rankings`, `scout_universe_overrides`, `scout_ranking_state`, `scout_bias_state`, `scout_rule_proposals`, `scout_guardian_directives`) | Admin/service-role scoped or read-only per role. Not user-owned. |

A user attempting `SELECT * FROM apex_execution_credentials` under
another user's JWT sees zero rows — RLS denies without leaking existence.
This is enforced by PostgREST and the same policies apply through the
signer's `CallerScopedDbClient` (raw REST + caller JWT).

---

## 5. Threat model (multi-user)

| Threat | Mitigation |
|--------|------------|
| **T1. User A reads/uses User B's ApeX credential** | RLS on `apex_execution_credentials` scopes SELECT to `auth.uid()=user_id`. Signer onboarding writes through the caller's JWT (RLS enforced). Signer execution paths (`sign-order`, `create-order`, `close-position`) source `user_id` from the fetched credential (`_db().fetch_active_credential(body.credential_id)` returns `cred["user_id"]`) — the request body cannot override ownership for STARK signing. |
| **T2. JWT forgery / replayed JWT** | Broker verifies against Supabase JWKS with issuer bound to the project URL. Supabase rotates keys; the broker fetches via the well-known JWKS URL each verification. Rate-limit key is per-user (last 24 chars of token) so a stolen token still gets its own bucket. |
| **T3. Replay of a broker → signer request** | Every signer route requires `x-signer-timestamp` within `SIGNER_ALLOWED_SKEW_SECONDS` (default 30s), `x-signer-nonce` cached for 2× the skew window, and `x-signer-signature` = HMAC-SHA256(secret, `ts\nnonce\npath\nrawBody`). Timing-safe compare. Path and body binding prevent cross-endpoint replay. |
| **T4. Signer bypass from the public internet** | Signer is exposed only inside the Railway private network (`*.railway.internal`). Preferred deployment (see `signer/TOPOLOGY.md` option 1). Any option-2 exposure still requires HMAC on every route including credential-touching paths. `/healthz` is the only unauthenticated route and returns `{"ok":true}` only. |
| **T5. RLS gap on a new table** | Every migration that creates a `public` table MUST enable RLS and write per-user policies in the same migration. The gate for future changes is: no un-RLS'd `public` table may ship. |
| **T6. Secret in logs / responses** | Fastify `redact` list on broker; `uvicorn.access` disabled on signer; `sanitize_response` allowlist on every signer response; `orders_v3` imports no logger; `test_secrets_never_leak.py` and `test_security.py` are part of CI. |
| **T7. Cross-user kill-switch / live-status trip** | `is_live` and kill switches live in per-user rows. RPC `public.is_execution_halted(p_user_id, p_connection_id)` is SECURITY DEFINER and self-scopes to `auth.uid() = p_user_id`; another user cannot query or trip another user's switch. |
| **T8. Fail-open on missing key / disabled flag** | `_signer_enabled()`, `_canary_enabled()`, and `operations.is_enabled(...)` default to false. `CryptoConfigError` → `ENCRYPTION_UNCONFIGURED`. Missing `SIGNER_SHARED_SECRET` → 500 `SIGNER_NOT_CONFIGURED`. Missing `SUPABASE_PUBLISHABLE_KEY` → boot refuses. |
| **T9. Wrapping-key blast radius (single master key wraps every user)** | AAD on the wrapping ciphertext binds each DEK to `user_id|wallet|environment`. Stealing the DB does NOT decrypt anything without the wrapping key. Stealing the wrapping key alone still does NOT let you decrypt without also stealing the DB rows. Per-user KMS keys are a future upgrade (see §7); the current model is acceptable while wrapping keys live only on Railway signer env. |

---

## 6. Build / verify gates (enforceable on every future change)

Any PR / turn that touches onboarding, signer, broker, credential storage,
RLS on user-owned tables, or the encryption model MUST satisfy every
gate below. No exceptions.

1. **Cite a passing test.** Not "I checked". A green test id in the
   agent's turn or a diff-line reference. If the change is untestable,
   explain why in-place and add a smoke test.
2. **Keep TS ↔ Python parity.** `shared/mainnet_parity_constants.json`
   is authoritative. Both sides load from it. Parity is a gate, not an
   IOU — a PR that says "will fix parity later" is rejected.
3. **Update this document if behavior changes.** Section 1 (flow),
   section 2 (guarantees), section 4 (RLS), or section 5 (threats) —
   whichever moved. Stale docs = broken standard.
4. **Never introduce a fail-open path.** Every new gate defaults to
   deny. A `try:` around a check MUST re-raise or return the denial;
   silent `except: pass` on a security check is a hard reject.
5. **Never trust client-supplied identity.** In auth-checked paths,
   `user_id` is derived from the verified JWT (`identity.sub`) or from
   an authoritative DB row (`cred["user_id"]`) — never from the request
   body. New endpoints that take `user_id` in the body MUST cross-check
   it against the JWT's sub and refuse on mismatch.
6. **Never widen RLS.** A migration that adds `USING (true)` on a
   user-owned table is a hard reject. `service_role` grants stay; extra
   `anon`/`authenticated` grants must be justified against §4.
7. **Never log or return crypto material.** New response fields go
   through `sanitize_response`. New log statements are reviewed against
   the redact list in `broker/src/server.ts` and the "no logger" rule
   in `orders_v3`.
8. **Every change ships its own reproduction path.** How the owner
   can verify the fix locally, without secrets, in one command.

---

## 7. Applied fixes (F2, F3)

- **F2 — IDENTITY_MISMATCH (defense in depth).** `signer/app/main.py`
  `/v1/onboard` independently decodes the caller JWT (already verified by
  the broker against Supabase JWKS) and asserts `jwt.sub == body.user_id`
  BEFORE the RLS-scoped INSERT. On mismatch the signer refuses with
  `IDENTITY_MISMATCH` (403). RLS remains the backstop. Tested in
  `signer/tests/test_identity_and_ownership.py`.
- **F3 — USER_MISMATCH (single owner for STARK + REST).** `create-order`
  and `close-position` derive the REST-credential owner from the
  authoritative `apex_execution_credentials` row (`cred["user_id"]`),
  never from `body.user_id`. `CreateOrderBody` has no `user_id` field at
  all; `close-position` refuses `body.user_id != cred.user_id` with
  `USER_MISMATCH` (403). Tested in the same file.

## 8. Non-custodial model (WITHDRAWALS OUT OF SCOPE)

TurtleBot holds **trade-only** authority. There is no code path in
`broker/`, `signer/`, or the worker that can initiate a withdrawal,
deposit, transfer, or payout. The non-custodial guarantee is composed of
four independent controls; all four must hold.

1. **Onboarding guidance (UI).** `/welcome/exchange` explicitly instructs
   the user to create a trade-only ApeX API key with **Withdrawals
   DISABLED**, and the Connect button is disabled until the user checks
   an attestation ("I confirm this API key has withdrawals disabled").
   The attestation is passed as `withdrawals_disabled_attestation` and is
   REQUIRED — the edge function rejects with `WITHDRAWAL_ATTESTATION_REQUIRED`
   otherwise.
2. **Venue-scope verification.** ApeX Omni exposes key permissions via
   the account snapshot. On `test` / verify, if the venue reports
   `permissions.withdraw === true`, the connection is marked
   `needs_attention` with subcode `WITHDRAWAL_SCOPE_PRESENT` and never
   moves to `verified`. Venues that do not expose key scope fall back to
   the attestation stored on the connection row. Which path each venue
   supports is recorded in `supabase/functions/_shared/exchange-adapter.ts`
   (`AccountSummary.permissions.withdraw`).
3. **Omni / STARK signing scope.** The wallet-signature onboarding
   authorizes only zkLink STARK material for order signing on ApeX Omni.
   It does not authorize withdrawals — ApeX withdrawal flows require a
   separate on-chain transaction from the user's own wallet, which the
   signer neither builds nor holds keys for. A user revokes by deleting
   the `apex_execution_credentials` row (or the parent
   `exchange_connections` row), which cascades and invalidates the
   fingerprint; the wallet's on-chain funds are unaffected.
4. **Hard block on withdrawals.** `signer/app/withdrawals.py` exports
   `WITHDRAWALS_ENABLED = False` as the single greppable guard any future
   withdrawal code must check. `signer/app/operations.py` allowlist
   contains no withdrawal-shaped verb. `signer/tests/test_withdrawals_guard.py`
   asserts (a) the flag is False, (b) `ALLOWED_OPERATIONS` contains no
   withdraw/payout/cashout/transfer verb, and (c) no route path in
   `signer/app/**` or `broker/src/**` contains a withdrawal verb.

Enabling withdrawals is a **separate, future, security-reviewed project**
that additionally requires a second on-chain re-consent signature (not
the onboarding signature), a new REST-credential scope contract, and a
new gated operation. Until all three exist, `WITHDRAWALS_ENABLED` stays
`False`.

## 9. Future upgrade path (recorded so it does not get lost)

- **Per-user KMS wrapping keys (F6, RECLASSIFIED as roadmap).** Because
  the non-custodial blast radius of a wrapping-key leak is limited to
  **trade-only authority on a funded account** — not fund loss, since
  withdrawal capability is structurally absent — F6 is roadmap, not a
  release blocker. The AAD scheme (`user_id|wallet|environment`) already
  prepared the ciphertexts for a per-user identity binding; a future
  migration can move from a single `APEX_MASTER_WRAPPING_KEY_V{N}` to a
  per-user KMS-wrapped DEK without re-collecting seeds.
- **Hardware attestation on the signer host.** Verify at boot that the
  Railway container has not been tampered with. Currently the trust
  boundary is Railway itself.
- **Move the legacy `execution-broker` edge function to the Railway
  broker.** Removes the `BROKER_SIGNING_SECRET` shared secret; identity
  comes entirely from the Supabase JWT.

These are RECORDED, not scheduled. Nothing above §9 is optional today.
