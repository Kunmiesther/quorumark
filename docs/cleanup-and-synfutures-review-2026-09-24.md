# Cleanup, account identity, and SynFutures integration review

## Release follow-up: SDK installation and public-chain integration

The follow-up release installs **`@synfutures/perpv3-ts@0.2.4`** with lockfile integrity hashes. It adds an authenticated admin-only SynFutures setup check to Exchanges. The generated SDK calls remain server-only and read-only; the UI never receives credentials or a signing client. The deployed database's app_role enum was checked: it contains admin/moderator/user, so authorization uses the existing admin role rather than inventing an owner enum value.

Public Base verification on 2026-09-25 01:51 UTC found:

- Gate registry: 65 instruments; seven instruments with listed expiries; zero expiry-read failures.
- SDK-default observer `0x16Ae357dFe705D1B9862132Dca02e07150876e3E` reverted on gate/settings reads.
- The [official Oyster Base deployment configuration](https://github.com/SynFutures/oyster-sdk/blob/main/src/config/base.json) specifies observer `0xDb166a6E454d2a273Cd50CCD6420703564B2a830`. Its bytecode, gate linkage and settings were verified on-chain. The adapter pins this read address and rejects unexpected gate/config relationships.
- Readable instruments with listed expiries include BTC-USDC-LINK and ETH-USDC-LINK. SOL and XRP were **not** in that returned set. An instrument listing does not prove sufficient liquidity, price freshness, or execution readiness.
- The remaining explicit blocker is `EXECUTION_ADAPTER_NOT_CONFIGURED`: private signing/delegation, approval/collateral setup, transaction lifecycle, close/cancel and reconciliation still need integration before automated orders. This release does not arm SynFutures or change ApeX/Aster settings.

The release checkout excludes unrelated unfinished growth-target, risk-lane, JEV and signer drafts. Additional compiler-confirmed private UI helpers were removed from the home/profile/welcome pages; the active components and layouts remain. No blanket deletion of shared primitives or engine validation calls was performed.

Release verification: the isolated full suite passed 1,815 tests (39 skipped); after correcting the Base observer mapping, all nine focused SynFutures tests passed and TypeScript passed. These are software checks and public-chain reads, not a live trade test. Earlier sections below describe the initial audit before the SDK installation.

## Initial cleanup audit: scope and protection (historical)

This was a conservative first cleanup pass, not a claim that every unused file across every deployed service was removed. Existing unfinished changes were preserved. No production credentials, exchange switches, strategy activation, positions, orders, deposits or withdrawals were changed. Dependencies were unchanged in that initial pass; the follow-up SDK installation is documented above.

## Removed with evidence

TypeScript `--noUnusedLocals --noUnusedParameters` initially reported 79 diagnostics. A TypeScript import-resolution scan also identified unreferenced component candidates. Candidates were checked against repository-wide text references before deletion; shared UI primitives, dynamically registered entrypoints, migrations, tests and unfinished features were not bulk-deleted.

Seven unreferenced UI files removed (recoverable from Git):

- `src/components/command/StatValue.tsx`
- `src/components/command/terminal/BotStatePill.tsx`
- `src/components/command/NetworkModeToggle.tsx`
- `src/components/command/LiveMainnetBanner.tsx`
- `src/components/turtle/CapitalGauge.tsx`
- `src/components/turtle/DemoModeBanner.tsx`
- `src/components/trade/FundsStrip.tsx`

Removed unused private TradeDesk helpers: InstrumentHeader, ChartToolbar, LegLegend, buildLegOverlays, PositionRail, OnyxVerdictCard, LifeMapSummaryCard, fmtCompact, Stat, IconBtn, plus their unused palette/type declarations and imports. Removed the unused OnyxPanel age formatter and compiler-confirmed unused imports in other files. The active chart, manual ticket, position table, strategy engine logic and execution controls remain.

The cinematic-background test formerly required an unused purple-vortex import. It now checks the six backgrounds actually paired with the six Turtles; the visible artwork is unchanged.

Repeat the read-only inventory with `node scripts/audit-unused-components.mjs`. Run the compiler's unused checks separately. Neither tool is sufficient authority to bulk-delete files. Remaining diagnostics include deliberately evaluated expressions and validation calls: for example, `timeframeMs()` can throw even though its assigned value is unused. Such calls must not be erased as dead behavior.

## Account identification

One shared identity renderer now serves saved automation assignments, live position reviews, trade-table positions and exchange wallet lists. It shows bundled exchange logos, exchange names even when an account is renamed, connection-ID prefixes, wallet-provider logos, wallet nicknames, addresses and statuses. Symbol logos also appear in saved plan rows.

An absent wallet assignment is explicitly shown as absent; an exchange account is not invented as a wallet. A missing explicitly recorded position wallet no longer silently substitutes another wallet merely because one is currently linked to the exchange. External Aster positions no longer carry a hard-coded `ApeX direct` badge. These are presentation/attribution fixes, not changes to signing authority.

Two stale ApeX-only display checks now use the existing shared ApeX/Aster supported-venue catalog. SynFutures remains unsupported for execution. This does not prove current broker availability or enable strategy rows; existing verification, runtime checks and owner controls remain. The screenshot's saved-plan status must not be relabeled as live merely to make it look connected.

## Initial cleanup verification (before release follow-up)

- Full regression suite: 222 test files passed, one skipped; 1,815 tests passed, 39 skipped.
- TypeScript no-emit check passed.
- After the final supported-venue display correction: all 58 focused regression tests passed. Targeted ESLint passed with no errors and one existing mixed-export Fast Refresh warning in ExchangeGroups. `git diff --check` passed.
- Production build passed. Existing dependency warnings include WalletConnect browser externalization and Fastify deprecations in tests; passing a build does not validate connected-wallet or exchange execution behavior.
- At the initial audit, changes were local and not deployed. No signed-in browser visual review or live order test had been performed. Release follow-up is tracked in PR #60; deployment status must be verified separately.
- The React checklist informed the shared identity component and explicit missing-data states. Supabase guidance informed the additive selection of the existing public wallet-provider field; no schema or access-policy changes were needed.

## SynFutures: current implementation versus recommended path

Repository facts: `SynFuturesAdapter` is a `PendingAdapter`. The readiness function checks Base RPC chain ID 8453, not an order lifecycle. The automation broker currently accepts ApeX and Aster only. SynFutures is not ready for live execution just because its logo or network probe exists.

Official source review, 2026-09-24:

- [SynFutures TypeScript SDK](https://github.com/SynFutures/ts-sdk): `@synfutures/perpv3-ts`, viem-based, RPC/API queries, trade/order simulation and event parsers.
- [SDK package documentation](https://github.com/SynFutures/ts-sdk/blob/main/packages/perpv3-ts/README.md): local Anvil devnet harness and transaction simulation tools.
- [Network configuration](https://github.com/SynFutures/ts-sdk/blob/main/packages/perpv3-ts/src/info.ts): includes Base mainnet. Contract addresses must still be verified against the pinned release and live bytecode.
- [Alternative SDK](https://github.com/SynFutures/sdks/tree/main/packages/perp): `@synfutures/sdks-perp`, an ethers-v5-based alternative with portfolio, trading and order operations.
- [Older Oyster SDK](https://github.com/SynFutures/oyster-sdk): requires attention to Gate token-native decimals versus Instrument 18-decimal amounts.

Registry checks found `@synfutures/perpv3-ts` latest **0.2.4**, while repository main declares **0.2.8**. The ethers-based package latest was **1.0.2**. Do not install an unreleased repository-main version as though it were the published package. Recheck and pin the actual released version and integrity before implementation.

### Engineering recommendation (not a claim of completed integration)

Use a small private TypeScript SynFutures adapter based on the viem SDK, subject to a pinned-release compatibility spike. The frontend already uses viem; the Python signer need not be converted. Keep protocol signing private and reuse the existing broker's authenticated intent, account ownership, worker queue, idempotency and audit machinery. Do not copy ApeX request signing or route SynFutures through the Aster REST adapter.

1. **Read-only discovery:** Base RPC health, deployed contract bytecode, instrument address/expiry/quote-token mapping, market limits, balances, margin, positions and gas balance. Resolve BTC/ETH/SOL/XRP to actual available instruments; do not assume all four use USDT or are listed.
2. **Transaction lifecycle:** isolated private signing/delegation design, per-wallet nonce serialization, allowance checks, gas estimation, SDK simulation, persisted transaction hash, confirmation/revert/reorg handling. A timed-out response must not produce a second trade.
3. **Adapter parity:** entry, cancel, close/reduce, stop/exit management, partial fills, position/fill reconciliation, account-level attribution. Reuse the existing normalized ledgers and decision evidence.
4. **Deterministic verification:** unit tests plus the SDK devnet/fork lifecycle. Prove two-wallet isolation, duplicate-intent protection, restart recovery, stale-data handling and five-rung compatibility before advertising supported automation.
5. **Owner setup:** chosen Base wallet/delegation, required token allowances, collateral and gas, then owner review of the live configuration. No keys are pasted into chat. SynFutures' conservative product label must not substitute for market-specific margin and risk checks.

The reusable infrastructure reduces the work; on-chain signing and settlement are the new work. The follow-up release installs the SDK and verifies public contract reads, but does not activate SynFutures execution.
