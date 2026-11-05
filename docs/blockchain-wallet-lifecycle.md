# Blockchain wallet lifecycle — 2026-09-26

## Scope

This release adds **manual, individually confirmed** Base and BNB swaps through
the registered Uniswap v3 routers. ETH/USDC and BNB/Binance-pegged-USDT remain
the defaults. A selected ERC-20 can replace the default token in either direction
against the chain's native asset. This is **not restricted to the four exchange
symbols**, but a quotable direct Uniswap v3 pool and successful wallet preflight
are required; discovery alone is not an execution route.
It does not arm strategies, supply funds, switch wallets, sign automatically,
or change existing ApeX/Aster positions or exchange configuration.

The public chain registry is not an execution allowlist. Solana and Robinhood
Chain remain read-only. SynFutures and Kraken execution are separate unfinished
integrations, not provided by this spot router.

## User flow

1. Choose an owned, verified mainnet wallet and chain in Exchanges → Blockchains.
2. Choose direction, amount and slippage; preview on-chain balances and quotes.
   For another token, use Scout → Blockchain discovery → Review token swap route,
   or select “Choose another token by contract address” in Exchanges. Select the
   wallet and explicitly inspect the contract. The handoff carries only chain and
   address: it never supplies a trusted ticker, decimals, wallet, router or amount.
   Contract code, chain, precision and a bounded symbol are read on chain, then
   checked again before preparation. Chain + address is the identity, not ticker.
3. Prepare a wallet review. If allowance is missing, review an exact-amount
   approval (or zero-reset for an existing insufficient allowance). Confirm it
   in the selected wallet; check its receipt, then prepare again.
4. For a swap, Council receives the actual chain/pool quote, without a wallet
   address or balance. It is explicitly told that no historical candle evidence
   was supplied. At least one seat must respond; advice is shown, not represented
   as a profitability guarantee. A fresh on-chain quote is taken after model
   latency, and changed pools or adverse movement beyond tolerance require review
   again. Existing Council provider configuration is reused, not changed here.
5. Review chain, full wallet, amount, minimum output, router and fees; acknowledge
   the real-funds action and explicitly confirm in the wallet. The exact chain
   and first selected account must match. The wallet repeats simulation before
   opening its signature prompt. Private keys never reach TurtleBot.
6. Use Transaction journal / Check receipt. A hash alone is not a confirmation.
   Verification compares sender, target, calldata, value, nonce, receipt status
   and canonical block hash. Two observed confirmations are required; this is
   not a claim of finalized settlement and later rechecks may detect reorgs.

## Recovery and accounting

- A draft can be handed off only once, with an atomic server compare-and-set.
  No automatic retry of `eth_sendTransaction` occurs.
- Rejected or preflight-failed requests are marked declined; transport failure
  after handoff remains unknown. The user checks wallet activity and recovers
  its hash instead of blindly sending again.
- The reported hash is cached locally and journaled before RPC receipt checks.
  A reported hash is visibly unverified until its transaction matches the plan.
- Journal entries stay inspectable when form amounts change, but a mismatched
  form cannot sign an old review.
- A wallet speed-up must match the original verified nonce and exact call.
  A same-nonce zero-value self-send is recorded as cancelled, not a swap.
  Previous hashes are retained. A mistyped/unobserved hash may be replaced only
  after the new transaction is observed and matched to the reviewed intent.
- Receipts show gas and observed fees. Missing Base L1 fees are explicitly
  labelled incomplete. Preview gas estimates exclude L1 data fees. An approval
  or confirmed transaction is not booked as a profit or a realized trade P&L.
- Actual output reconciliation and portfolio cost-basis accounting remain a
  prerequisite for automated strategy performance reporting.

## Security

The journal uses RLS and owner-only SELECT. Clients have no INSERT/UPDATE/DELETE
grants. Authenticated server functions scope every read/write by owner and verify
wallet ownership again before handoff. The server compiles only fixed-router
transactions; client inputs cannot select arbitrary contracts or calldata.

No new dependency or broad wallet permission is introduced. Public RPC capacity
is limited; dedicated production RPC endpoints use server-only configuration.
Real-wallet signing, mobile/remote wallet compatibility, and live receipt evidence
must be verified separately from mocked unit tests. Non-custodial architecture
does not itself establish jurisdictional eligibility.

## Selected-token limitations

- Direct native/token pools on the registered Uniswap v3 deployment only; no
  arbitrary router, arbitrary calldata, cross-chain, multi-hop or token/token path.
- Contract metadata and a successful quote are not a contract audit, a liquidity
  quality assessment, manipulation detection or a guarantee of future sellability.
  Token names are untrusted; custom tokens use a neutral badge, not a ticker-based
  branded logo that could incorrectly imply authenticity.
- Fee-on-transfer and rebasing tokens are not supported by this route. See
  [Uniswap's token integration notes](https://developers.uniswap.org/docs/protocols/v3/concepts/unsupported-tokens).
  There is no claim of automatic tax/honeypot detection in this release.
- The token address, chain, precision and symbol are bound to the saved request.
  Changing selection invalidates a pending signing review, including while the
  wallet handoff is awaiting a response. Approval targets the actual input token
  and grants only the selected router an exact amount (or a separate zero-reset).
- Existing journal records without a token descriptor retain their original
  chain-specific stablecoin. No schema migration or wallet credential change.
- Actual output reconciliation and autonomous Arbiter strategy execution remain
  unfinished; do not describe these manual controls as automated blockchain trading.

## Accepted roadmap, not a completion claim

1. Complete and test the blockchain wallet execution foundation.
2. Arbiter gets two separately identified strategies:
   - **Arbitrage:** executable bid/ask comparisons, net fees/gas/slippage,
     coordinated legs, exposure recovery and separate results. A displayed
     spread alone is not an arbitrage fill; cross-chain legs are not atomic.
   - **Fresh-token momentum:** token discovery, sellability/contract and liquidity
     evidence, manipulation checks, price/volume confirmation, exit capacity,
     and independent results. A newly listed pool or boosted profile is not proof
     of safety or genuine demand. No promise of catching every pump.
   Each needs its own user-selected allocation, limits, attribution and testing.
   Learning uses recorded outcomes and held-out evaluation, not automatic promotion
   of untested rules. Neither strategy is armed by this release.
3. Finish SynFutures collateral/signing/open/close/cancel/receipt/worker lifecycle.
4. Add a complete Kraken integration (the current public ticker adapter is not one).
5. Refresh dashboard and sign-in, preserving the existing design language and
   applying the approved glossy day/night finish.
6. TradingView bring-your-own-strategy integration is later, not this release.

## Test entry points

`npx vitest run src/lib/blockchain src/components/exchanges/__tests__/blockchain-swap-execution.test.tsx src/components/exchanges/__tests__/blockchain-networks.test.tsx src/lib/wallet/providers.test.ts src/lib/ai/committee/__tests__ --maxWorkers=1`

`npx tsc --noEmit --pretty false`

Tests mock wallet submissions and RPC receipts; they never send mainnet transactions.
The public RPC integration tests are opt-in and read-only. CI runs the full
regression suite and production build before this branch can be released.
