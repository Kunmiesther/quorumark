# ApeX Execution Authority Matrix

Phase 2 remediation, updated 2026-09-15. Traces every callable path that can read from
or write to ApeX Omni, plus the flag/gate that governs each.

## Environments

| Environment       | Venue id (DB)       | Status                                                                                                                                                                                                     |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ApeX Omni mainnet | `apex_omni`         | Reads always-enabled on signer (`OPERATION_ENABLED`), broker preflight gated by `APEX_MAINNET_READS_ENABLED`; writes globally disabled until `APEX_MAINNET_SIGNER_ENABLED` + `APEX_MAINNET_CANARY_ENABLED` |
| ApeX Omni testnet | `apex_omni_testnet` | Only `testnet_proof` path (legacy) or Railway reads                                                                                                                                                        |

## Authoritative callable paths

| Operation                                                      | Path                                                                                                  | Auth                                                                      | Gate / flag                                                                                                                                         | Notes                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reads (READ_ACCOUNT / MARKETS / ORDERS / POSITIONS)            | Railway `broker/src/server.ts` `POST /v1/intents/preflight`                                           | Supabase JWT (JWKS)                                                       | Broker: `APEX_MAINNET_READS_ENABLED` + `ALLOWED_OPERATIONS` allowlist. Signer: `OPERATION_ENABLED[op] == true` (defaults true for reads).           | Delegates to private signer over HMAC. Writes are structurally excluded from `ALLOWED_OPERATIONS`.                                                                                                                                    |
| Signer reads (`VERIFY_CREDENTIALS`, READ_*)                    | Railway `signer/app/main.py` — private hostname only                                                  | HMAC (`SIGNER_SHARED_SECRET`) via broker                                  | `signer.OPERATION_ENABLED[op] == true`                                                                                                              | Not internet-exposed.                                                                                                                                                                                                                 |
| Owner manual canary order                                      | Vercel `manualLiveTest` → Railway broker `POST /v1/orders` → private Railway signer `POST /v1/orders` | Supabase bearer JWT at both public boundaries; HMAC from broker to signer | Admin role, owned verified mainnet ApeX connection, trade permissions, `is_live=true`, fail-closed kill switch, broker + signer signer/canary flags | Exact symbols `BTC-USDT`, `ETH-USDT`, `SOL-USDT`, `XRP-USDT`; MARKET entry only; ≤ $100 authoritative venue notional; ≤ 5x; signer protection required. The browser cannot supply a user id, venue, purpose, or connection ownership. |
| Other signer writes (BUILD/SIGN/CREATE/CANCEL/CLOSE/RECONCILE) | Railway signer                                                                                        | HMAC via broker                                                           | Operation flags plus signer/canary/compliance gates                                                                                                 | Not exposed directly to browsers.                                                                                                                                                                                                     |
| Worker → broker order intents                                  | `bot_worker.RailwayTurtleBot.submit_order_intent` → Railway `POST /v1/automation/orders`              | Replay-protected HMAC (`BROKER_SIGNING_SECRET` / `WORKER_ORDER_SHARED_SECRET`) | Worker `LIVE_TRADING_ENABLED`; broker signer + canary + automation flags; signer repeats ownership, kill-switch, exposure, collateral, and idempotency checks | Credential-free strict intent. The worker never receives a JWT, Supabase admin key, exchange credential, or signer secret.                                                                                                         |

## Deprecated / structurally disabled paths

| Path                                    | Current form                                                                                                                                                                                           | Notes                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `supabase/functions/execution-broker`   | Rejects any `apex_omni*` venue with `APEX_EXECUTION_MOVED_TO_RAILWAY_BROKER (410)` when `APEX_EXECUTION_MOVED_TO_RAILWAY=true`. Check hoisted before body parsing and credential decryption (Phase 2). | The only ApeX adapter imported here is `ApexOmniTestnetAdapter`; when the flag is on, no ApeX code is reachable. |
| `supabase/functions/run-live-proof`     | 410 stub                                                                                                                                                                                               | No live/mainnet proof callers remain.                                                                            |
| `supabase/functions/run-testnet-proof`  | 410 stub                                                                                                                                                                                               | Legacy proof-token minter, no active caller.                                                                     |
| `supabase/functions/apex-testnet-trade` | 410 stub                                                                                                                                                                                               | Removed.                                                                                                         |

## Single-authority guarantee

- **Reads (mainnet):** Railway broker only. Supabase edge functions do not
  ship a mainnet ApeX adapter.
- **Writes:** Browser manual canaries use `POST /v1/orders`; automated worker
  intents use `POST /v1/automation/orders`. The routes use different auth and
  flags, converge only at the private signer, and repeat fail-closed venue and
  account checks there.
- **Legacy Supabase broker:** With `APEX_EXECUTION_MOVED_TO_RAILWAY=true`,
  the function short-circuits on method+flag alone, without parsing the
  intent body, verifying the HMAC, calling `is_execution_halted`, or
  loading `exchange_credentials`. Turning the flag off is the only way to
  reach the legacy `testnet_proof` code path — and even that path is
  purpose-allowlisted and rejects `is_live=true` in `proof-gate.ts`.

## Change-control invariants

Do not (without explicit owner reversal):

- Add a mainnet ApeX adapter import to any Supabase edge function.
- Add a browser-reachable write route or allow the automation route to accept
  a bearer token, database key, arbitrary venue, arbitrary symbol, or raw
  credential material.
- Flip any `OPERATION_ENABLED` entry to `true` in `signer/app/operations.py`
  without matching broker allowlist + canary flag changes.
- Reintroduce `"unspecified"` to broker purpose allowlists.
- Weaken the fail-closed reservation contract (see Phase 2 remediation
  in `supabase/functions/execution-broker/index.ts`).
