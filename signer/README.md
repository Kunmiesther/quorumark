# ApeX Omni Mainnet Signer Service

**Private** Railway service. NOT publicly routable. The browser MUST NOT call
this service — only the Supabase `execution-broker` edge function does, over
service-to-service HMAC.

## Topology

```
Browser  →  Supabase execution-broker  →  private Railway signer  →  ApeX Omni
```

## Endpoints (all POST, all HMAC + timestamp + nonce protected)

- `POST /v1/onboard`     — verify wallet signature over the canonical ApeX
                           Omni onboarding message, derive zkLink STARK
                           material in trusted memory, envelope-encrypt with
                           the master wrapping key, return only the
                           `credential_id` + `credential_fingerprint`.
- `POST /v1/sign-order`  — build + STARK-sign a mainnet order payload for
                           an existing `credential_id` and submit through
                           the official `apexomni` SDK. Returns the
                           sanitized broker result (status, exchange_order_id,
                           exchange_status, reject_reason). Never returns
                           seeds, l2Key, API secret, or passphrase.
- `POST /v1/reconcile`   — read-authoritative reconciliation of an
                           `exchange_order_id` by `client_order_id`.
- `POST /v1/revoke`      — mark a credential bundle revoked; further sign
                           calls for it fail immediately.

## Required Railway environment

| Variable | Purpose |
|---|---|
| `SIGNER_SHARED_SECRET`            | HMAC key shared ONLY with the edge function. |
| `SIGNER_ALLOWED_SKEW_SECONDS`     | Default `30`. Requests older/newer are rejected. |
| `APEX_MASTER_WRAPPING_KEY_V1`     | Base64 32 bytes. Wraps per-bundle DEKs (AES-256-GCM). |
| `APEX_MASTER_WRAPPING_KEY_ACTIVE` | Active version integer (e.g. `1`). |
| `SUPABASE_URL`                    | For fetching + updating `apex_execution_credentials`. |
| `SUPABASE_SERVICE_ROLE_KEY`       | Service role. Never logged. |
| `APEX_MAINNET_SIGNER_ENABLED`     | `false` by default. Must be `true` to sign. |
| `APEX_MAINNET_CANARY_ENABLED`     | `false` by default. Guards `is_live` orders. |

## Security invariants (do NOT relax)

1. Debug mode is off (`FASTAPI_DEBUG=0`); tracebacks never returned.
2. Request bodies + headers are redacted from all logs.
3. Every response is filtered through `sanitize_response()`.
4. Cryptography uses `cryptography.hazmat.primitives.ciphers.aead.AESGCM`
   (audited AEAD). We do NOT hand-roll ciphers or key derivation.
5. STARK derivation runs on ephemeral variables; plaintext seeds are
   overwritten and dereferenced immediately after encryption.
6. Withdrawals / deposits / transfers are unreachable — no route exists.
7. Every request is signed with `x-signer-signature` + `x-signer-timestamp`
   + `x-signer-nonce` and replay-protected by a rolling nonce cache.

## Pinning

- Python: `python:3.11.9-slim@sha256:<OWNER MUST FILL IN>`
- ApeX SDK: `git+https://github.com/ApeX-Protocol/apexpro-openapi.git@<COMMIT_SHA>`
  Owner MUST paste the reviewed commit SHA into `requirements.txt` and rerun
  the SBOM + vulnerability scan before enabling the signer.
- All Python dependency versions + hashes pinned in `requirements.lock`
  (generated with `pip-compile --generate-hashes`).

## Status

**NOT PRODUCTION READY.** This directory is scaffolding. Before enabling:

- [ ] Owner reviews and pastes the exact `apexomni` SDK commit SHA.
- [ ] Owner runs official offline SDK tests + TurtleBot fixture tests.
- [ ] Owner runs `pip-compile --generate-hashes` and commits `requirements.lock`.
- [ ] Owner generates the Docker image digest and pins it.
- [ ] SBOM + `pip-audit` clean on Linux.
- [ ] Railway private-networking configured (no public ingress).
- [ ] `SIGNER_SHARED_SECRET` + `APEX_MASTER_WRAPPING_KEY_V1` provisioned
      via Railway secrets. Never committed.
