# TurtleBot Execution Broker (Railway, public)

Public HTTPS entrypoint for TurtleBot ApeX Omni intents. Enforces
authentication, ownership, kill switch, rate limits, and operation
allowlists. Delegates any exchange call to the private signer over HMAC.

## Trust boundary

```
browser ──HTTPS──▶ turtlebot-broker (this service, public)
                         │
                         │  Supabase JWT verified against JWKS
                         │  caller-scoped queries; RLS enforces ownership
                         │
                         ▼
                   turtlebot-signer  (*.railway.internal, PRIVATE)
                         │
                         ▼
                   ApeX Omni REST
```

- The browser NEVER holds `SIGNER_SHARED_SECRET`.
- `user_id` comes exclusively from a verified Supabase JWT — never from
  the request body.
- The signer has no public domain.

## Endpoints

| Method | Path                     | Purpose                                          | Auth       |
| ------ | ------------------------ | ------------------------------------------------ | ---------- |
| GET    | `/healthz`               | liveness + flag booleans (no secrets)            | none       |
| GET    | `/readyz`                | verifies signer is reachable                     | none       |
| GET    | `/v1/whoami`             | proves JWT + Supabase path                       | Bearer JWT |
| POST   | `/v1/intents/preflight`  | authorized ApeX read (`READ_*` operations only)  | Bearer JWT |
| POST   | `/v1/orders`             | bounded owner-only internal manual canary order  | Bearer JWT |

The only mutating public route is `/v1/orders`. It accepts a strict minimal
body and derives the caller, connection, venue, and purpose on the server.
It permits only `BTC-USDT`, `ETH-USDT`, `SOL-USDT`, or `XRP-USDT` MARKET
entries up to $100 authoritative venue notional and 5x leverage. Admin role,
connection ownership, verified trade permissions, `is_live`, kill switch,
signer/canary flags, and signer-side protection are all mandatory. Automated
execution and all other public writes remain disabled.

## Environment matrix (names only)

Required:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`       (publishable/anon key — the broker queries Supabase as the CALLER via bearer JWT; RLS enforces `auth.uid()` ownership. Legacy `SUPABASE_ANON_KEY` is accepted under the same slot.)
- `SIGNER_BASE_URL`               (e.g. `http://turtlebot-signer.railway.internal:8080`)
- `SIGNER_SHARED_SECRET`          (identical value on broker + signer)
- `WORKER_ORDER_SHARED_SECRET`   (identical to `BROKER_SIGNING_SECRET` on the worker; distinct from signer and Supabase secrets)
- `CORS_ALLOWED_ORIGINS`          (comma-separated exact origins)

Optional:

- `SUPABASE_JWT_ISSUER`           (defaults to `${SUPABASE_URL}/auth/v1`)
- `SUPABASE_JWKS_URL`             (defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
- `SIGNER_TIMEOUT_MS`             (default 5000)
- `RATE_LIMIT_PER_MIN`            (default 60)
- `APEX_MAINNET_READS_ENABLED`    (broker-only preflight gate for `READ_*` / `VERIFY_CREDENTIALS`; provision once at deploy — NOT part of the LIVE_ACTIVATION flip sequence, which starts at `APEX_MAINNET_SIGNER_ENABLED`)
- `APEX_MAINNET_SIGNER_ENABLED`   (true only during an approved internal canary)
- `APEX_MAINNET_CANARY_ENABLED`   (true only during an approved internal canary)
- `APEX_MAINNET_AUTOMATION_ENABLED` (enables only the worker-HMAC automation route)
- `APEX_MAINNET_CAPITAL_ENABLED`  (same-account Funding ↔ Perps moves; requires signer enabled and the execution halt cleared)
- `PORT`                          (Railway injects)
- `NODE_ENV`                      (default `production`)

Never expose `SIGNER_SHARED_SECRET` to the browser or to logs. The broker
holds NO service-role key: ownership is enforced by Supabase RLS against
the caller's JWT. Fastify's redaction rules already scrub known paths;
audit any new field for leaks before adding logs.

## Operational guarantees

- **HTTPS only** — Railway terminates TLS at the edge.
- **Strict CORS** — only origins in `CORS_ALLOWED_ORIGINS` are accepted.
  Requests without an `Origin` header are allowed for non-browser
  callers; protected routes still require either a valid JWT or the dedicated
  worker HMAC, depending on the route.
- **Rate limiting** — 60 rpm/user by default via `@fastify/rate-limit`,
  keyed by JWT tail or IP.
- **No debug/docs** — Fastify ships no docs endpoint; there is no
  Swagger/OpenAPI route mounted in production.
- **Generic public errors** — clients get `{ error, correlation_id }`;
  detail is in server logs under that correlation id.
- **Fail closed on kill switch** — any RPC/DB error is treated as
  HALTED.
- **Signer reachability failure** returns 503 `SIGNER_UNREACHABLE`;
  never falls back to a local sign path.

## Local development

```
bun install --cwd broker    # or: cd broker && npm install
cd broker && npm run typecheck
```

Do NOT run the broker against production Supabase or a live signer
locally.

## Deployment notes

- Base image digest pinned 2026-07-25 — see Dockerfile `FROM` lines.
