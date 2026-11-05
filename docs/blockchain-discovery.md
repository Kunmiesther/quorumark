# Blockchain discovery and spot preflight

## Available surfaces

- **Scout → Blockchain discovery**: authenticated, on-demand DEX Screener searches for Base, BNB Chain and Solana. Scout's drawer links to this section. This search is independent of the existing strategy-scanning switch.
- **Exchanges → Blockchain → Base / BNB**: a verified, owned EVM wallet can request a read-only Uniswap v3 direct-pool quote and wallet preflight. Base uses native ETH / Circle USDC; BNB uses native BNB / Binance-pegged USDT. These are not cross-chain swaps.
- Robinhood Chain is not queried using an invented DEX Screener chain ID. Coverage remains unverified. Solana discovery does not imply a Solana execution adapter is enabled.

## Data and identity

DEX Screener's public API requires no account or API key for these endpoints:

- `GET /latest/dex/search?q=...`
- `GET /token-pairs/v1/{chainId}/{tokenAddress}`

Official reference: https://docs.dexscreener.com/api/reference

The provider documents a 300-request/minute limit for these endpoints. Our adapter uses a bounded 100-entry, 30-second per-process cache, shared in-flight requests, an eight-request concurrency ceiling, a 120-request/minute per-process cap, ten-second timeouts, and a provider-wide per-process 429 cooldown. These are **not distributed quota guarantees** across serverless instances; a shared cache/rate limiter is needed before scaling request volume substantially. Searches are explicit, not continuous polling.

Pool identity is chain + pool address. Token identity is chain + token address. Symbols, names and logos are untrusted metadata. Unknown metrics stay unknown. Ranking uses liquidity or volume, never purchased boosts. UI labels show the fetch time, not a claim that the provider's underlying observations are instantaneous. Search results are not a complete market universe. Contract-address searches are preferred.

## Execution boundary

Discovery results are not automatically added to any execution allowlist. There is no token approval, wallet signing, order submission, Council invocation or automation activation in Scout discovery.

The spot preflight verifies chain ID, registry contract presence, router factory/wrapped-native identity, token decimals and recent block time. Quotes and balances share a block number. It compiles exact-input calldata with a bounded slippage minimum and deadline, but does not expose an executable transaction to the browser. A wallet-specific `eth_call` and gas estimate run only when balances and allowance permit. Base's estimated execution gas does **not** include its additional L1 data fee. `executionReady` remains false even after simulation succeeds.

Server-only RPC overrides: `TURTLEBOT_BASE_RPC_URL`, `TURTLEBOT_BNB_RPC_URL` (HTTPS required). Defaults are public, throttled endpoints suitable for light preflight checks, not an execution availability guarantee. Public Base endpoint: https://base.publicnode.com/. No provider keys belong in `VITE_*` variables.

Still required for blockchain live execution: Council review integrated with the chosen route, fresh quote/fees at approval time, wallet authorization, transaction submission and receipt/reconciliation states. Autonomous operation additionally needs explicit scoped delegation, durable orchestration and recovery. Discovery alone does not enable any of these.

## Verification

Run normal unit/UI tests with `npm test`. Optional public read-only smoke checks:

```sh
RUN_PUBLIC_DISCOVERY_CHECKS=1 npx vitest run src/lib/scout/__tests__/discovery.test.ts
RUN_PUBLIC_SPOT_CHECKS=1 npx vitest run src/lib/blockchain/spot.test.ts
```

These checks make public reads/quotes only, never submit a transaction. They do not prove funded execution or profitability.
