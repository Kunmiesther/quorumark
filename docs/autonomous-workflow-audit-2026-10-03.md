# Autonomous trading workflow audit — 2026-10-03

Target: independently executing routes across centralized exchanges, DEX venues and direct wallet/blockchain execution, with deterministic attribution, exposure controls, reconciliation and measured performance. DEX and blockchain describe overlapping architecture; an API-connected DEX is not evidence that direct wallet automation exists.

## Audited execution paths

Worker configuration -> venue-native candle/HTF data -> regime/strategy -> selected Turtle -> canonical decision -> worker safety -> authenticated broker -> private signer sizing -> durable intent reservation -> venue protection verification -> fill/position reconciliation. Also reviewed mandate creation/editing, capability contracts, paper isolation and the manual blockchain transaction foundation. This report identifies reviewed paths and remaining gaps; it does not certify every repository file or profitability.

## Corrections in this change

| Finding | Correction | Regression evidence |
|---|---|---|
| HTF cache keyed only by symbol/timeframe could supply ApeX candles to Aster | Bind cache to the actual venue feed instance | Two-feed test with different candles |
| Failed 1D/4H reads cached until the next large timeframe boundary | Cache successful frames; retry failed reads on the next cycle | Transient failure followed by successful reads |
| Sequential cross-venue loop makes a slow venue delay another | Two bounded venue workers, same-venue serialization, isolated guard/evaluation failures | Concurrent barrier and failure/order tests |
| ApeX defaulted missing mandate leverage while Aster rejected it | Shared strict whole-number parsing; explicit mandate leverage required | Invalid/missing leverage never reaches sizing/transport |
| Saved live mandate limits were disconnected from signing reservations | Database admission trigger under a mandate row lock checks status, schedule, daily campaign count, pending/open positions and recorded attributed losses | Actual PostgreSQL trigger; five rungs use one campaign slot, concurrent admissions cannot exceed limits |
| Plan builder hard-coded one daily entry and one open position | Owner inputs and review summary; explicit daily range 1–100, concurrent range 1–6 | Shared bounds + database checks |
| Existing live plans lacked a way to repair leverage and limits together | Authenticated owner edit updates proposal + all linked rows + audit atomically, checks revision/ownership/venue ceiling | Real PostgreSQL owner, stale revision, grants and rollback tests |
| Broker global readiness depended only on ApeX flags | Readiness checked independently for each venue and its private signer gate | Aster-only runtime and unreachable-signer tests |
| Live setup accepted unsupported/read-only/testnet venues | Shared frontend/backend mainnet/trading-permission policy | Route policy tests |
| ApeX hedge lookup contradicted one-way execution registry | Supported live adapters report one-way; paper keeps separate simulated wallets | Dual-direction regressions |
| Capability matrix omitted Vanguard and mislabeled Arbiter as a trend leg | Correct strategy inventory; unimplemented Arbiter execution denied; Sweep remains a strategy with explicit live limitation | Capability contract regressions |
| Worker comments described active live execution as observation-only | Updated execution-path documentation | Code review against actual dispatch |

Existing mandates remain at their saved settings until the owner explicitly edits them. No leverage, allocation, wallet, venue, Turtle selection or existing position is automatically changed. Reduce-only exits bypass entry-only mandate constraints.

## Production findings at audit start

- Two verified mainnet/production accounts: ApeX Omni and Aster.
- Eight enabled live rows: BTC/ETH/SOL/XRP on each venue; selected Turtle is Accumulator.
- Both saved live plans specify one daily entry and one concurrent position. Both lack a leverage choice in saved proposal and execution params.
- Prior 24-hour decisions included Aster leverage-invalid refusals and historical ApeX protection receipt errors; the latter receipt parser was fixed in PR 97. Historical ambiguous intents remain reconciliation work and must not be replayed as new entries.

## Remaining requirements for the full goal

| Route/function | Current evidence | Work still required |
|---|---|---|
| ApeX/Aster API DEX automation | Authenticated five-rung entry adapters, protection checks, independent runtime gates | Owner chooses leverage and operational limits; observe natural orders/fills/exits and reconciled results |
| Sweep live execution | Complete paper campaign; live explicitly blocked | Shared full campaign TP/trailing lifecycle and reconciliation parity before enabling |
| CEX automation | CEX integrations are not on the autonomous execution allowlist | Choose a supported account; complete native order/cancel/close/fill/collateral lifecycle and tests |
| Base/BNB direct wallet swaps | Individually confirmed manual transactions and receipt journal | Owner-scoped signing/delegation, autonomous allocation/limits, output/cost-basis reconciliation and exit lifecycle |
| SynFutures | Setup/delegation/module integration candidate; no enabled production account observed | Verified deployed module, funded/approved collateral and complete worker/open/close/cancel/receipt integration |
| Solana/Robinhood chains | Read-only discovery/network evidence | Native signer, executable router/liquidity, simulation and receipt lifecycle |
| Arbiter arbitrage/momentum | Roadmap/catalog only | Executable coordinated legs, fees/gas/slippage model, recovery and independent results |
| Net profitability | Passing workflow tests is implementation evidence | Held-out backtests, realistic fees/funding/gas/slippage, actual fill attribution and forward drawdown/performance evidence |

High volume means many independently qualified setups within explicit exposure limits. It does not mean repeated identical orders, bypassing eligibility, assuming hedge mode, replaying uncertain outcomes, or representing configured routes as profitable fills.

Live mandate loss admission uses attributed closed-position P&L already recorded in the system. Complete fee/funding accounting and timely venue reconciliation remain essential; a missing recorded P&L blocks further entries for that mandate. Pending/uncertain campaign reservations retain capacity until a newer position reconciliation confirms closure.
