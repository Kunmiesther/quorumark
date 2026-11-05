# Three-venue gap closure — 2026-10-03

The target includes Aster, ApeX and SynFutures, plus Kraken Spot execution and direct Base wallet trading. Kraken Spot and Base were explicitly selected during this work. Auto trading must discover every eligible native venue market, rather than being hard-coded to four symbols; supported execution, collateral and owner exposure checks still apply.

## Verified current state

- Mainnet Aster and ApeX connections are verified and live-enabled.
- SynFutures has a registered Base Safe/module, recorded as deployed_operator_pending. Its saved draft is $100 allocation with a 33x ceiling, revision 1. No SynFutures exchange connection or trade transaction is recorded.
- ApeX has 65 historical reconciliation-required intents for unconfirmed stop protection. They remain unresolved; this change never retries, cancels or clears them.
- The system contains venue fills and verified closed trade rows, but closed position rows retained prior unrealized P&L. Those fields are not complete realized accounting evidence.
- Neither the current Kraken connection nor direct Base autonomous signing authority has been established.

## Completed in this change

1. Position reconciliation runs bounded independent connections concurrently; failures retain per-connection results.
2. User-triggered reconciliation authenticates via getUser and filters to verified owner identity. Scheduled cross-account reads require an exact configured server credential.
3. A fresh complete position/open-order snapshot is distinct from historical order uncertainty. Risk-reducing Council management can use fresh exposure evidence while uncertain entry receipts remain visible.
4. Newly observed closure clears stale mark/unrealized fields and records realized P&L as unknown. Venue flatness does not prove an exit price or net return. Existing historical values are not rewritten without fill attribution.
5. Conditional close writes check owner, connection, live source, open status and snapshot time. A stale close cannot overwrite a newer reconciliation.
6. SynFutures reads both markets' actual limits and its authorized operator's gas at the verified Base block. Readiness names missing collateral, session, module, market and gas prerequisites.
7. The existing authenticated live-fills cron independently observes registered SynFutures accounts every five minutes and records owner-scoped readiness evidence. It does not sign, fund, authorize or activate trading.
8. Owner UI exposes these fresh SynFutures activation requirements.

## Remaining milestones, without omitting SynFutures

| Milestone | Required work / prerequisite |
| --- | --- |
| Aster/ApeX operation | Explicit owner leverage and frequency settings; actual order/fill/exit verification; resolve historical ApeX protection evidence |
| SynFutures execution | Dedicated operator signer, authenticated worker/broker dispatch, durable transaction/nonce handling, simulation, complete protective exits and owner-signed session authorization |
| SynFutures funding | Verify actual Safe collateral and gas; owner-reviewed approval/deposit using exact token units |
| Kraken | Connect the selected Spot account; native create/query/cancel/fill/exit lifecycle with durable idempotency and account-scoped risk limits |
| Direct Base | Delegated signing/limits, automatic swaps, exact token balances/cost basis, receipts/reorg recovery and exits |
| Accurate performance | Match historical fills to the actual originating campaign; complete fees/funding/gas; avoid using stale position marks as realized P&L |
| Scale | Cross-route portfolio admission and measured throughput; increase volume only from observed execution and drawdown results |

This is an operational reconciliation milestone, not completion of autonomous order execution across all routes or proof of profitability. Software tests and deployment health do not substitute for account authority or actual venue receipts.
