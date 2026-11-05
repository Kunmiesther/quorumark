# Railway worker (`bot_worker.py`) environment

Authoritative list of environment variables the Railway `worker` service
actually reads at runtime. Do not add anything else to that service.

## Required (exact names — spelling matters)

| Variable                      | Kind               | Notes                                                              |
| ----------------------------- | ------------------ | ------------------------------------------------------------------ |
| `SUPABASE_URL`                | https URL          | Lovable Cloud project URL.                                         |
| `SUPABASE_PUBLISHABLE_KEY`    | `sb_publishable_…` | The **only** Supabase key the worker is allowed to hold.           |
| `SUPABASE_PROJECT_ID`         | project ref        | Used for logging / registry lookup, never as a credential.         |
| `WORKER_INGEST_SHARED_SECRET` | 64 hex chars       | HMAC secret shared with the `worker-ingest` edge function.         |
| `WORKER_INGEST_WORKER_ID`     | string             | Matches the row in the worker registry table.                      |
| `WORKER_INGEST_KEY_VERSION`   | integer            | Matches the active key version for this worker.                    |
| `WORKER_VERSION`              | commit SHA         | Deployed git commit SHA. Reported as `version` on every heartbeat. |

`WORKER_VERSION` is how the running revision becomes observable: set it on the
Railway `worker` service to the exact commit SHA being deployed. The worker
falls back to Railway's automatic `RAILWAY_GIT_COMMIT_SHA` when `WORKER_VERSION`
is absent, and logs the selected variable name at boot:
`Worker version source var=WORKER_VERSION version=<sha>`. The value lands in
`public.worker_heartbeats.version`, so
`select worker_id, version, last_seen_at from public.worker_heartbeats`
proves which code the live worker is actually running. A `null` version means
neither variable is set — treat the running revision as unverified.

## Automation-only variables

| Variable                     | Kind        | Notes                                                                                                  |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `LIVE_TRADING_ENABLED`       | boolean     | Defaults `false`. Set `true` only after the capability probe reports automation ready.                 |
| `TURTLE_BROKER_BASE_URL`     | https URL   | Public Railway broker base URL. The worker calls only `/v1/automation/orders`.                         |
| `BROKER_SIGNING_SECRET`      | HMAC secret | Must match `WORKER_ORDER_SHARED_SECRET` on the Railway broker. Never use a Supabase or signer secret.  |

## Must NOT be set on the worker service

The worker hard-removes Supabase admin credentials. It will refuse to
leave demo mode if either admin credential below is present in its environment,
and each is treated as a deployment error (never as an authorization):

- `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY` — server-only
  credentials. Belong on the Supabase Edge Function secret store (and,
  from Stage 3, the Railway broker), never on the Railway `worker`.
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
  `VITE_SUPABASE_PROJECT_ID` — frontend build-time only. Delete on the
  worker service so they cannot silently act as backend fallbacks.

## Health / readiness — what is NOT a check

`GET /rest/v1/` is the PostgREST OpenAPI root. It requires `sb_secret_*` or a
legacy service-role JWT and returns `401` to any publishable key. It is
**admin-only** and must never be used as a worker health or readiness check.
Reachability is a pure transport probe: any HTTP response (including `401`)
proves the host answered. Readiness is proven only by a successful signed
`worker-ingest` heartbeat plus a successful `read_active_config()` call.

---

## Configuration Correction Record

### Entry 1 — `SUPABASE_PUBLISHABLE_KEY` was not actually confirmed on the worker

- **Verification date:** 2026-07-15
- **Commit SHA:** `c70ff43`
- **Evidence source:** Railway container stdout, `worker` service, deploy
  following the env-var rename and removal of the `VITE_*` variables.
- **Previous assumption:** `SUPABASE_PUBLISHABLE_KEY` was set and confirmed on
  the Railway `worker` service (listed under "Confirmed configuration" in a
  prior status report).
- **Actual prior state:** The variable was misspelled `SUPABASE_PUBLIHABLE_KEY`
  (missing the `S` in `PUBLISHABLE`). The correct value was present under the
  wrong name, so nothing in the worker's key-candidate list matched it. The
  worker silently fell through to `VITE_SUPABASE_PUBLISHABLE_KEY` — a
  frontend build-time convention with no business acting as a backend
  credential source — and worked by accident. The misconfiguration was
  invisible because the readiness gate failed at `GET /rest/v1/` (401,
  admin-only) before the worker ever logged which variable it had selected.
- **Corrected verified state:** `SUPABASE_PUBLISHABLE_KEY` is present on the
  worker service, correctly spelled, and confirmed as the runtime-selected
  key source via the boot log line
  `Supabase key source var=SUPABASE_PUBLISHABLE_KEY kind=sb_publishable`.
  The `VITE_SUPABASE_*` variables have been deleted from the worker service.
  `worker-ingest` heartbeat and `ACTIVE_CONFIG_READ` both authenticated;
  demo → paper transition completed in ~1.2 s.
- **Verification method:** Runtime log assertion of the selected env-var
  **name** — not dashboard inspection. Commit `c70ff43` separated transport
  reachability from HMAC authorization and added per-stage logging; that is
  what made the misconfiguration observable, not any change to the variable
  itself. Dashboard inspection is what produced the original false
  attestation, because a misspelled variable looks present to the eye.

### Transferable lesson

A configuration item is only "confirmed" when a running process has reported
that it read it. Dashboard presence proves a variable exists; it does not
prove any process resolved it. A misspelled variable name is invisible to
visual inspection and silently falls through to whatever fallback exists —
so every "confirmed" claim for a credential must cite a runtime log line
naming the variable that was actually selected.
