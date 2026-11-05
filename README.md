# Quorumark Strategy Exchange

Quorumark is a NEAR oriented marketplace for autonomous trading methods. Creators publish versioned private strategies with inspectable evidence. Followers subscribe, receive signals, and make independent paper execution decisions under their own risk policy.

## The working demo

Open the application and use these routes:

* `/marketplace` discovers the clearly labeled sample strategy.
* `/marketplace/aurora-breakout` shows its version, evidence class, equity curve, and sandbox subscription action.
* `/studio` runs a deterministic reference backtest and keeps its output labeled backtested.
* `/follower` applies a follower policy to the latest signal, deduplicates the signal, and creates a paper receipt only when accepted.
* `/verification` recomputes net return, win rate, trade count, and fees from execution records.

The browser demo persists its state locally so judges can complete the flow without a provisioned backend. The Supabase migration in `supabase/migrations/20261105090000_strategy_exchange.sql` defines the durable production tables, indexes, and row level policies for strategies, versions, subscriptions, signals, risk policies, decisions, and executions.

## Safety boundary

All executions in this contribution are paper executions. There is no production trade path. The strategy sample is not a claim of live performance. Evidence is classified as backtested, paper traded, testnet executed, or live verified, and only the first two are currently reachable in the exchange demo.

Wallet connection uses the existing EIP 1193 and EIP 6963 discovery plus the server issued challenge and signature verification functions. A wallet connection is not treated as an authenticated session by itself. Native NEAR wallet support and a first class wallet session still require a configured NEAR wallet adapter and backend session exchange.

NEAR Intents is isolated behind `src/lib/near-intents-adapter.ts`. Official documentation describes quote request, solver quote selection, wallet authorization, relay submission, and onchain settlement verification. Until Quorumark has a supported route, relay endpoint, and credentials, the adapter refuses quote and transaction preparation instead of fabricating hashes or confirmations.

## Local development

```sh
npm ci
npm run dev
```

Required public variables for the existing backend are `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Wallet challenge verification requires the existing `wallet-challenge` and `wallet-verify` Supabase functions. The exchange demo remains usable without them, but wallet authentication will report that the backend is not configured.

Useful checks:

```sh
npx tsc --noEmit
npm run lint
npm test
npm run build
```

The exchange contribution is new hackathon work layered over the existing Quorumark paper trading, wallet verification, audit, and Supabase infrastructure. Existing TurtleBot and legacy execution surfaces remain isolated and are not activated by this marketplace.
