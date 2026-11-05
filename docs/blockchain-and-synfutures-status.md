# Blockchain desk and SynFutures — 2026-09-25

This is the historical discovery/preflight release audit. For the subsequent
manual wallet execution work and its remaining verification requirements, see
[Blockchain wallet lifecycle](blockchain-wallet-lifecycle.md). It does not imply
that Arbiter automation or SynFutures live execution has been delivered.

## Delivered in this change

- Exchanges now distinguishes the blockchain network desk from existing CEX/DEX accounts.
- Base (8453), Solana mainnet, Robinhood Chain (4663), and BNB Smart Chain (56) are explicit choices.
- Wallet selection uses owned, active, verified records. EVM addresses are usable across compatible networks; no Solana address is inferred from an EVM address or wallet brand.
- On-demand native balance reads first verify EVM chain ID or Solana genesis. Failures are not presented as zero balances. Results show timestamp, address, gas asset and explorer link.
- SynFutures Base market discovery feeds an indicative quote form. The deployed observer's legacy `inquireByNotional` ABI is used, not the incompatible newer helper ABI. Registry membership, expiry, amount, chain and quote direction are validated.
- Real public RPC checks passed for all four networks and both directions of a discovered BTC SynFutures market. Public Base RPC rate limiting was observed; these endpoints are not an execution SLA.

## Not delivered / not executable yet

The subsequent owner-controlled Safe integration candidate is documented in
[`contracts/synfutures/README.md`](../contracts/synfutures/README.md). It adds a
restricted, revocable module, unsigned setup builder and local/fork lifecycle
tests. It remains undeployed and is **not connected to the production worker**;
the remaining execution work below is not superseded by those test results.

These network entries are **not execution venues** and are not added to the automation execution allowlist. This change never signs, approves, submits, transfers, arms, or changes positions.

SynFutures still needs wallet signing/delegation, collateral approval/deposit UX, transaction simulation with slippage and margin checks, submission, receipt reconciliation, open/close/cancel lifecycle tests, and worker integration. A quote is not a simulated transaction or a fill. The quote fee excludes gas and does not establish sufficient collateral.

Base/BNB/Solana/Robinhood spot trading still needs a selected router with verified deployments and executable liquidity, transaction construction/simulation, the correct wallet signer, and receipt reconciliation. Listing a chain does not provide these pieces. Solana needs a separately verified Solana wallet address. Production load needs a provisioned RPC strategy rather than assuming unlimited public endpoints.

Non-custodial is an asset-control property, not a legal or jurisdiction determination. Existing trading eligibility and configuration are unchanged.

## Turtle strategy inventory

Read-only configuration audit found eight enabled live DCA rows: BTC, ETH, SOL and XRP on each of ApeX and Aster. Their `enabled_turtles` lists contain only `accumulator`. This is configuration evidence, not proof of executions or profitability.

- Accumulator: DCA / range accumulation; currently selected in those rows.
- Vanguard: breakout/trend route; implemented but not selected in those rows.
- Sniper: sweep/reversal route; implemented but not selected in those rows.
- Hunter: liquidity-hunting route; implemented but not selected in those rows.
- Scout: detection/monitoring role; a catalog row is not proof of an independent live execution strategy.
- Arbiter: funding-arbitrage catalog entry; no verified live arbitrage lifecycle established in this audit.

## Verification

- Focused unit/component tests cover wallet compatibility, ownership boundary, chain mismatch, zero versus failed reads, quote allowlisting, units, direction, validation, responsive IDs and non-executing controls.
- `RUN_PUBLIC_CHAIN_CHECKS=1 npx vitest run src/lib/blockchain/publicReads.integration.test.ts` performs only public mainnet reads; skipped in ordinary CI to avoid making builds depend on public RPC availability.

## Official references

- https://docs.base.org/chain/network-information
- https://solana.com/docs/references/clusters
- https://docs.robinhood.com/chain/add-network-to-wallet/
- https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/
- https://github.com/SynFutures/oyster-sdk/blob/main/src/config/base.json
