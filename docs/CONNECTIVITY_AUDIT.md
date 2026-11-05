# TurtleBot connectivity audit

Last reviewed: 2026-09-18

## Intended production topology

1. Vercel schedules market, committee, AI-advisory, position-management, and watchdog cycles.
2. Supabase persists connections, decisions, intents, positions, fills, and operational health.
3. The Railway worker evaluates completed 15-minute candles and supervises active positions every five minutes.
4. The Railway execution broker validates an order request and forwards it to the private signer.
5. The signer is the only component that holds ApeX signing material and submits to the venue.
6. Deposits and withdrawals remain user-confirmed wallet actions. Internal transfers between ApeX funding and perpetual balances use the capital-flow service.

## Verified in this revision

- Every Vercel cron route accepts the platform `CRON_SECRET`; no second per-route secret is required.
- The market cycle, committee cycle, advisory cycle, TP council, and watchdog have explicit schedules in `vercel.json`.
- The Trust Center probes the broker, signer, manual-order route, automation capability, and capital route separately.
- The UI no longer equates a saved venue permission with runtime execution readiness.
- Mainnet order intents are read from the real ledger instead of a hard-coded empty list.
- The worker fails closed: `LIVE_TRADING_ENABLED` defaults to `false`.
- The worker's decision interval is 15 minutes, with five-minute supervision retained for open positions.

## Automated-live deployment requirement

Manual owner-authorized orders use Railway `/v1/orders`. Automated orders use the separately authenticated Railway `/v1/automation/orders` route added in this revision. The code path is complete, but it is not operational until the worker and broker are deployed from the same revision and share the dedicated machine credential.

Do not set `LIVE_TRADING_ENABLED=true` merely because the UI or signer is healthy. Enable it only after all of the following are true:

- the Railway broker deployment exposes the worker-safe automation route;
- the route verifies a machine credential distinct from an owner browser JWT;
- broker and signer share and verify their signing secret;
- `WORKER_ORDER_SHARED_SECRET` on the broker matches `BROKER_SIGNING_SECRET` on both the worker and Vercel (the TP council is also an automated reduce-only caller);
- `TURTLE_BROKER_BASE_URL` is set on the worker;
- the capability probe reports automation ready;
- one minimum-size mainnet proof-of-life order completes broker → signer → ApeX → fill reconciliation;
- the kill switch and position reconciliation are observed working in the same deployment.

## External deployment checks

- Confirm all six Vercel cron jobs appear after deployment and their invocation logs remain successful.
- Confirm Vercel has `CRON_SECRET`, `TURTLE_BROKER_BASE_URL`, and the same `BROKER_SIGNING_SECRET` used for the broker's `WORKER_ORDER_SHARED_SECRET`.
- Confirm Railway worker and broker environment variables against `docs/WORKER_ENV.md`.
- Confirm scheduled position/fill reconciliation is deployed and current.
- Complete the mobile release doctor items before store distribution.
