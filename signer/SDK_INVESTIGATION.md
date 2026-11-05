# ApeX Omni SDK investigation (pinned commit `4d849dd8`)

Findings that must be verified against the actually-installed SDK before
`/v1/onboard`, `VERIFY_CREDENTIALS`, or `READ_ACCOUNT` handlers are
implemented in `signer/app/main.py`. Nothing in this document changes
runtime behavior — it is the contract the next PR must satisfy.

## 1. Do our existing `exchange_credentials` support `READ_ACCOUNT`?

Schema evidence (`public.exchange_credentials`, verified 2026-07-17):
- `encrypted_api_key`, `encrypted_api_secret`, `encrypted_passphrase`,
  `encrypted_omni_seed` — HMAC-family REST auth material.
- Foreign-keyed to `exchange_connections`; one row per connection.

Schema evidence (`public.apex_execution_credentials`):
- `wallet_address`, `apex_account_id`, `encrypted_credentials`,
  `credential_fingerprint` — zkLink STARK material derived by the
  signer during `/v1/onboard`.

Verdict:
- **REST reads (positions, balances, account, orders, markets)** are
  authenticated via the HMAC scheme already implemented client-side in
  `src/lib/exchanges/apex-omni-sign.ts` — apiKey / apiSecret /
  passphrase. Those match the fields in `exchange_credentials`.
  `READ_ACCOUNT` therefore does NOT require `register_user_v3()` or
  `change_pub_key_v3()` for accounts that already have working ApeX
  REST credentials.
- **zkLink STARK signing** (any `POST /v3/create-order` variant) does
  require a registered account and a published `pubKeyHash`. That is
  `register_user_v3()` and `change_pub_key_v3()` territory — but only
  when we transition from reads to writes, which is out of scope for
  this PR (canary and `SIGN_ORDER` remain disabled).

Implication for the read handler: it reads from
`exchange_credentials`, not `apex_execution_credentials`. Building a
competing credential system would be a design defect. The two tables
have distinct responsibilities.

## 2. Credential bundle contract

### 2a. Bundle for `READ_ACCOUNT` (per connection)

Source: `public.exchange_credentials`, decrypted via the app-side
envelope key (NOT `APEX_MASTER_WRAPPING_KEY_V1`, which wraps zk STARK
material only).

```
{
  "api_key":     "<opaque>",
  "api_secret":  "<opaque>",
  "passphrase":  "<opaque>"   // optional; present for accounts that set one
}
```

Usage: signed REST call to `GET /api/v3/account`, `/positions`,
`/open-orders`, `/user-balance`. The base string is exactly the one in
`src/lib/exchanges/apex-omni-sign.ts` — same HMAC scheme, same
double-base64 secret handling.

### 2b. Bundle for zkLink STARK signing (per credential)

Source: `public.apex_execution_credentials.encrypted_credentials`,
decrypted via `APEX_MASTER_WRAPPING_KEY_V*` and AAD =
`f"{user_id}|{wallet_address}|{environment}"`.

Required fields (verified against `signer/app/apex_signing.py`):

```
{
  "seeds":        "<130 hex chars, no 0x — the wallet's EIP-191 signature IS the zk seed>",
  "l2_key":       "<derived STARK public key>",
  "pub_key_hash": "<derived pubKeyHash>",
  "apex_account_id":  "<optional — populated after register_user_v3 succeeds>",
  "sub_account_id":   "<optional integer — defaults to 0>"
}
```

Only `seeds` is required for `sign_order()`. `l2_key` and
`pub_key_hash` are cached for fingerprinting; the signer re-derives
them at every call and MUST match on read (belt and braces against a
tampered ciphertext that survives GCM verification only because AAD
was reused across environments — the `EnvelopeContext.aad()` guard
already blocks this).

## 3. Preconditions before implementing the new handlers

The next PR MUST prove each of the following before enabling any new
endpoint. Do NOT ship a handler without a corresponding failing→passing
test.

- [ ] Confirm the pinned SDK exposes `register_user_v3()` and
      `change_pub_key_v3()` under `apexomni.http_private_v3` at commit
      `4d849dd8`. If names have changed, update this doc first, code
      second.
- [ ] Confirm `GET /api/v3/account` accepts the HMAC scheme in
      `apex-omni-sign.ts` byte-for-byte. A single trailing-slash or
      lowercasing mismatch produces an `INVALID_SIGNATURE` that looks
      like a credential problem and burns a rotation.
- [ ] Add a `.functions.ts`-free path from broker → signer for
      `/v1/read`. The broker already calls `/v1/read` (see
      `broker/src/server.ts:290`) but the signer has no such route.
      The endpoint must be added under a new operation gate; do NOT
      overload `/v1/sign-order`.
- [ ] Add handler tests mirroring `test_dry_run_real_signing.py`:
      spy on the real REST call, assert credential material never
      appears in the response, assert no order-submission fetch
      occurs.

## 4. What is explicitly out of scope for this PR

- No `/v1/read` handler, no `/v1/verify-credentials`, no
  `/v1/onboard` implementation.
- No new columns on `apex_execution_credentials` or
  `exchange_credentials`.
- No flag flips. `SIGN_ORDER`, `APEX_MAINNET_SIGNER_ENABLED`, and
  `APEX_MAINNET_CANARY_ENABLED` all remain off.
- No deployment.
