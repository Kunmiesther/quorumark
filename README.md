# Quorumark Strategy Exchange

Quorumark is a NEAR-oriented marketplace for autonomous trading methods. Creators build versioned strategies, attach inspectable paper evidence, and publish private signals. Followers subscribe, apply their own risk rules, and execute independently in a paper or supported testnet environment.

## Product demo

- `/` presents the Strategy Exchange.
- `/marketplace` discovers the clearly labelled sample strategy.
- `/marketplace/aurora-breakout` shows its version, risk, evidence class, equity curve, and sandbox subscription action.
- `/studio` runs a deterministic reference backtest.
- `/follower` evaluates a signal against follower policy, deduplicates it, and creates a paper receipt only when accepted.
- `/subscriptions` shows sandbox entitlement state.
- `/verification` recomputes metrics from execution records.
- `/connect-wallet` presents native NEAR first and compatible EVM wallets second.

The browser can browse the demo without a provisioned database, but paper decisions and executions now go through the Python backend. Local development uses an explicit SQLite ledger at `backend/.data/quorumark.db`; it is not a substitute for applying the Quorumark migrations to a Quorumark-owned Supabase project. Without a configured authenticated database, multi-user persistence remains unavailable.

## Safety and evidence

Every execution in this repository is paper, sandbox, or explicitly supported testnet only. There is no live-money execution path. Backtested, paper-traded, testnet-executed, and live-verified evidence classes remain separate; the demo does not claim live performance.

Wallet challenge and signature verification are isolated in the two retained Supabase Edge Functions. Wallet connection alone is not treated as a production trading authorization. Native NEAR wallet selector/session exchange remains configuration-dependent and is surfaced honestly when unavailable.

NEAR Intents is isolated in `src/lib/near-intents-adapter.ts`. It refuses quote or settlement claims until a supported relay, route, and credentials are configured; it never fabricates a transaction hash.

## Local development

```sh
npm ci
npm run dev
```

Copy `.env.example` to `.env.local` and provide only the values required for the environment you are testing. Public `VITE_*` values are safe for the browser; session secrets, provider keys, service-role keys, and Intents credentials are server-side only. Never commit `.env`, `.env.local`, private keys, or credentials.

Checks:

```sh
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

The Python engine is a separate service:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
python -m uvicorn app.main:app --reload --app-dir backend --port 8000
```

Set `VITE_PYTHON_BACKEND_URL=http://127.0.0.1:8000` in `.env.local`, then start the frontend with `npm run dev`. Strategy Studio sends its validated candle fixture to the Python service and renders the returned metrics; it does not silently fall back to frontend-generated performance.

The Python service also owns follower paper decisions at `POST /v1/paper/executions`. It validates candle chronology and freshness, evaluates the follower's independent limits, applies paper fees and slippage, records an idempotency key, and returns a `paper_traded` evidence hash. The endpoint never calls a broker or signer.

## Provenance

This repository was reconstructed into a focused Quorumark application from an inherited codebase. Unrelated execution workers, mobile shells, social-growth modules, legacy deployment files, generated marketing assets, and their migrations were removed from the active tree. The retained application code and new Strategy Exchange vertical slice are maintained for the Quorumark hackathon; no inherited production service is used as a silent fallback.
