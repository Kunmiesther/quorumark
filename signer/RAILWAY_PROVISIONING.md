# Railway + Supabase provisioning manifest

Names only. **No values in this repository, in Lovable settings, in the
frontend environment, in migration files, in logs, or in `.env.example`.**

All four mainnet feature flags must remain `false` at the close of Phase B.1.
Only the owner may flip them, and only after this phase's readiness report
is signed off.

## Railway service: `apex-signer`

Deployed from `signer/Dockerfile`. Must live inside a Railway private
network — no public ingress. Inbound execution traffic is only from the
public Railway `turtlebot-broker` via HMAC-signed requests.

### Secrets (Railway → Variables)

| Name                              | Purpose | Generation |
|-----------------------------------|---------|------------|
| `SIGNER_SHARED_SECRET`            | HMAC key used by broker → signer requests. | `openssl rand -hex 32` |
| `SIGNER_ENVELOPE_MASTER_KEY_V1`   | AES-256-GCM master wrapping key (base64, 32 bytes). Envelope-wraps every stored credential bundle. | `openssl rand -base64 32` |
| `SIGNER_ENVELOPE_MASTER_KEY_ACTIVE` | Version pointer. Start at `1`; bump on rotation. | Set to `1`. |
| `SIGNER_ALLOWED_CALLER`           | Fully-qualified Supabase project ref allowed to call the signer (`sthdmulczzebfcmihhca`). | This must match the TurtleBot Supabase project. |
| `SIGNER_MAX_CLOCK_SKEW_SECONDS`   | Max request age in seconds. | Set to `30`. |
| `SIGNER_NONCE_TTL_SECONDS`        | Nonce replay window. | Set to `60` (>= 2× skew). |
| `SUPABASE_URL`                    | Signer writes reconciliation state directly. | Copy from Supabase project settings. |
| `SUPABASE_SERVICE_ROLE_KEY`       | Service-role key for state writes. Never leaves Railway. | Copy from Supabase project settings. |
| `APEX_MAINNET_BASE_URL`           | ApeX Omni mainnet REST base. | `https://omni.apex.exchange` (owner to confirm from api-docs.pro.apex.exchange) |
| _(no `APEX_MAINNET_READS_ENABLED` on the signer)_ | Reads are always-enabled on the signer via `signer/app/operations.py::OPERATION_ENABLED` — no env flag is read. The identically-named broker flag lives on the broker Railway service only. | n/a on signer. |
| `APEX_MAINNET_SIGNER_ENABLED`     | Allow `BUILD_ORDER` + `SIGN_ORDER`. Does NOT submit. | `false` — flip only for the dry-run rehearsal. |
| `APEX_MAINNET_CANARY_ENABLED`     | Allow one owner-authorized `CREATE_ORDER`. | `false`. |
| `APEX_MAINNET_AUTOMATION_ENABLED` | Allow bot-scheduled `CREATE_ORDER`s. | `false`. |
| `APEX_MAINNET_CAPITAL_ENABLED`    | Allow USDT allocation between Funding and Perps on the same ApeX account. Never enables external withdrawal. | `false` until the internal capital-flow review is approved. |

## Railway service: `turtlebot-broker`

The broker signs every outbound signer call with `SIGNER_SHARED_SECRET`
and enforces authentication, admin role, caller ownership, the fail-closed
kill switch, symbol/notional/leverage limits, and feature gates before
dispatching. The retired Supabase `execution-broker` must not be used for
ApeX mainnet execution.

### Secrets (Railway → Variables)

| Name                    | Purpose |
|-------------------------|---------|
| `SIGNER_BASE_URL`       | Railway private-network URL of `apex-signer` (e.g. `http://turtlebot-signer.railway.internal:8080`). |
| `SIGNER_SHARED_SECRET`  | **Same value** as the Railway secret of the same name. Copy once, never diverge. |
| `SIGNER_TIMEOUT_MS`     | Timeout for signer HTTP calls (recommend `10000`). |

The four `APEX_MAINNET_*` flags live in Railway only. For internal manual
testing, `SIGNER_ENABLED` and `CANARY_ENABLED` must agree on broker and
signer while `AUTOMATION_ENABLED` and worker `LIVE_TRADING_ENABLED` remain
`false`.

The Vercel app receives only the public broker URL in
`TURTLE_BROKER_BASE_URL`; it never receives `SIGNER_SHARED_SECRET`.

## Provisioning order

1. Owner generates every secret above locally (or in a password manager).
2. Owner pastes each value into Railway Variables for `apex-signer`.
3. Owner pastes `SIGNER_SHARED_SECRET` and `SIGNER_BASE_URL` into the
   Railway `turtlebot-broker` variables.
4. Owner deploys `apex-signer` from `signer/Dockerfile`. Verify with
   `curl` inside the Railway private network — never from the public
   internet.
5. Run the signer's offline test suite one final time inside the deployed
   container: `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests/`.
6. Only after the readiness report is re-signed: complete credential
   onboarding via the wallet-signature UI. Every `APEX_MAINNET_*` flag
   stays `false` until the LIVE_ACTIVATION ceremony (`docs/LIVE_ACTIVATION.md`).

## Rotation

- `SIGNER_SHARED_SECRET`: generate a new value, deploy to both Railway
  services in the same window, and observe zero 401s.
- `SIGNER_ENVELOPE_MASTER_KEY_V*`: add `V2`, set
  `SIGNER_ENVELOPE_MASTER_KEY_ACTIVE=2`, re-encrypt every stored bundle,
  then delete `V1`.
- `SUPABASE_SERVICE_ROLE_KEY`: rotate in Supabase; deploy to Railway
  before the old key is revoked.

Never commit any of these values. Never echo them in logs, tracebacks,
or the signer's HTTP responses (see `app/security.py::sanitize_response`).
