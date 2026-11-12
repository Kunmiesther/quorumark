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

When running locally, the Python service also exposes the connected marketplace slice: `POST /v1/strategies` creates a creator-owned draft, `/v1/strategies/{id}/versions` records a version, `/v1/strategies/{id}/publish` publishes it, `GET /v1/strategies` lists published records, `POST /v1/subscriptions` creates a sandbox entitlement, and `/v1/follower/policy` stores a follower policy. These protected routes require `x-quorumark-identity` and are intentionally enabled only when `QUORUMARK_PYTHON_ENVIRONMENT=local`; this is a development adapter, not a production authentication mechanism. Hosted use must replace it with a verified Supabase session before enabling writes.

## Safety and evidence

Every execution in this repository is paper, sandbox, or explicitly supported testnet only. There is no live-money execution path. Backtested, paper-traded, testnet-executed, and live-verified evidence classes remain separate; the demo does not claim live performance.

Wallet challenge and signature verification are isolated in the two retained Supabase Edge Functions. Wallet connection alone is not treated as a production trading authorization. Native NEAR wallet selector/session exchange remains configuration-dependent and is surfaced honestly when unavailable.

NEAR Intents is isolated in `src/lib/near-intents-adapter.ts`. The current
sandbox adapter deliberately refuses quote, transaction-preparation, and
settlement-verification requests. `NEAR_INTENTS_RELAY_URL` and
`NEAR_INTENTS_API_KEY` are reserved for a future supported relay; empty values
do not disable any current demo path because no relay is called.

The reference backtest supports two explicit data sources: deterministic,
labeled fixture candles for offline runs, and a server-side public historical
OHLCV adapter. Set `MARKET_DATA_PROVIDER=binance_public` or
`kraken_public`; these public adapters require no API key and record provider,
symbol, interval, and source metadata. If a provider is unreachable, the API
returns an error; it never substitutes fixture candles or presents history as
live performance. `MARKET_DATA_API_KEY` is not required by either adapter.

The AI strategy-proposal, refinement, analysis, and agent-assessment routes use
a server-only Gemini GenerateContent API when `AI_PROVIDER=gemini`, a NEAR AI
Cloud OpenAI-compatible chat API when `AI_PROVIDER=near_ai`, or an
OpenAI-compatible Responses API when `AI_PROVIDER=openai` or
`openai_compatible`. All outputs are strictly Pydantic-validated and persisted
with provider/model provenance. NEAR AI Cloud is optional: configure
`NEAR_AI_API_KEY`, a model returned by its `/v1/model/list` endpoint, and
`AI_API_URL=https://cloud-api.near.ai/v1` only after obtaining an authorized
key. The application does not claim NEAR AI inference until a real request
succeeds. With AI disabled or unavailable, these routes return an explicit
unavailable error; they never substitute deterministic text while claiming a
model was called.
For the zero-cost Gemini path, create a key in the official Google AI Studio
(`https://aistudio.google.com/apikey`), without linking a paid billing project,
then set `AI_PROVIDER=gemini`, `AI_API_KEY` server-side, and
`AI_MODEL=gemini-3.5-flash`. Free-tier model access and quotas are
account/region dependent; the API returns an unavailable error when the key,
quota, or selected model is not eligible. Do not paste the key into the
browser or commit it.

The native NEAR wallet path configures Meteor Wallet and My NEAR Wallet
directly through Wallet Selector on testnet. `VITE_NEAR_WALLET_CONNECTOR_URL`
is not used and is intentionally absent from `.env.example`; a custom
connector URL is not required for the current wallet flow.

## Hackathon walkthrough

Quorumark serves strategy creators who need inspectable, versioned evidence and
followers who want independent risk controls before acting on a signal. The
creator flow is: authenticate with a NEAR wallet, create and configure a
strategy, run the Python simulation engine, save a draft, create an immutable
version, publish it, and optionally anchor its domain-separated commitment on
NEAR testnet. The follower flow is: discover a published method, inspect its
risk and evidence class, subscribe, configure limits, simulate a signal,
inspect the paper execution, verify recomputed performance, and pause or
cancel the subscription.

AI analysis is an explicitly configured, schema-validated aid around strategy
research and inspection; when unavailable, the product says so. Quorumark
does not claim autonomous trading or fabricated performance. The Python engine produces the genuine backtest and
paper-execution results. Supabase stores authenticated identities, ownership,
versions, subscriptions, and evidence with server-side authorization. NEAR
Wallet Selector handles testnet authentication, and the narrow Rust contract
stores only an immutable publication commitment—not strategy parameters or
private logic.

For a credential-safe demo, use the public landing page, inspect the sample in
Marketplace, run the Studio simulation, open Follower to apply risk controls,
open Verification to recompute the ledger, then show Connect Wallet and the
testnet-only evidence explanation. A real wallet signature and any contract
deployment must be approved by the wallet owner; browser automation covers
the UI and rejection paths but does not approve wallet prompts.

## Live judge links and demo plan

- Web application: https://quorumark-web.onrender.com
- Python service health: https://quorumark-api.onrender.com/health
- Evidence contract: `quorumark-evidence-dedicated.testnet`

For a two-to-three minute demonstration: open the landing page and Marketplace;
enter Strategy Studio and describe a cautious Bitcoin method; show the AI
proposal and its plain-English explanation; run the clearly labelled sample-data
test; save and publish a version; open the Marketplace record; then switch to
Follower Desk to set an independent paper-risk policy and inspect the decision
history. Finish by showing the Verification page and, only with the creator's
explicit wallet approval, the NEAR testnet publication transaction preview.

Screenshots used for the release walkthrough are in `artifacts/screenshots/`.
They document the interface only and are not evidence of a completed wallet
signature, AI provider call, historical return, or blockchain transaction.

The release intentionally excludes live trading, real-money settlement,
custody, recovery phrases, cross-chain settlement claims, and unsupported AI
autonomy. The publication-evidence contract is deployed at
`quorumark-evidence-dedicated.testnet`; the owner-controlled publisher must still approve each publication
transaction in a testnet wallet before the application can display confirmed
evidence.

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

For a clean Windows start with readiness checks, use `npm.cmd run dev:local`.
For local hosted-Supabase persistence, use `npm.cmd run dev:hosted`. The launcher
starts only missing services, checks both `/health` and the frontend, and writes
sanitized process logs under the system temporary directory. It never prints
provider keys or session secrets.

## Public deployment preparation

`render.yaml` defines the smallest free-tier deployment shape: one FastAPI web
service and one TanStack/Vite Node web service. Render documents free web
services and static sites, but free services can sleep and are intended for
testing or hobby use, not production. Deployment still requires the repository
owner to authorize a Render/GitHub connection and enter the server-only values
in the dashboard. Set `VITE_PYTHON_BACKEND_URL` to the final HTTPS API URL and
`QUORUMARK_ALLOWED_ORIGINS` to the final HTTPS frontend URL before testing.

Required server-only deployment values are `QUORUMARK_SUPABASE_SECRET_KEY`,
`QUORUMARK_SESSION_SECRET`, and either `AI_API_KEY` for Gemini or
`NEAR_AI_API_KEY` for NEAR AI. When using NEAR AI, set `AI_PROVIDER=near_ai`,
`AI_MODEL` to a model returned by its catalog, and keep
`NEAR_AI_API_URL=https://cloud-api.near.ai/v1`. Required public values include
the Supabase URL and publishable key. Never put server-only values in a
`VITE_*` variable or commit them.

The Python service also owns follower paper decisions at `POST /v1/paper/executions`. It validates candle chronology and freshness, evaluates the follower's independent limits, applies paper fees and slippage, records an idempotency key, and returns a `paper_traded` evidence hash. The endpoint never calls a broker or signer.

## Provenance

This repository was reconstructed into a focused Quorumark application from an inherited codebase. Unrelated execution workers, mobile shells, social-growth modules, legacy deployment files, generated marketing assets, and their migrations were removed from the active tree. The retained application code and new Strategy Exchange vertical slice are maintained for the Quorumark hackathon; no inherited production service is used as a silent fallback.
