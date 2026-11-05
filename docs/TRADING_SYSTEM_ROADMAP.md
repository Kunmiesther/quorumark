# TurtleBot: evidence-backed trading system

Owner-approved direction, 2026-09-26. This is an implementation and acceptance
ledger, not a claim that planned capabilities are already available.

## Product contract

Discover → qualify → decide → authorize → execute → protect/manage → reconcile
→ measure → propose/test improvements. Keep venue, wallet/account, book,
strategy version and decision identity attached throughout.

- Onyx guides configuration and explains evidence.
- Scout gathers and qualifies opportunities.
- Turtles own identifiable, versioned strategies.
- Council reviews evidence and uncertainty. Today the decision-review process
  is post-hoc advisory; do not label it entry approval or autonomous management.
- LangGraph coordinates persisted workflows and recovery. Installing it alone
  does not establish reliable execution or learning.
- Broker/signers implement venue-specific execution, authorization, idempotency,
  protection and reconciliation independently of model availability.
- Preserve the neumorphic design, owner control, manual tools and existing positions.
- No guaranteed daily return, fabricated live status, or hidden paper/live blending.

## Stage 1 — repair the foundation (current)

- [x] Local stable broker-sized entry keys; preserve accepted existing keys.
- [x] Local explicit leverage capture/persistence in live setup and arming review.
- [x] Restore production `ai_decision_opinions` with owner-only reads and service writes.
- [x] Verify production RLS and role grants through catalog queries.
- [x] Local evaluator reports storage failures; cron returns degraded status on failure.
- [x] Local saved-plan view exposes conflicting plan/row state and paused exchanges.
- [x] Remove unused MarketSentiment component with hard-coded "Live" metrics.
- [x] Release application, worker and edge changes; PR77 production revision
      `b3f0d65b3c220103a681a88a688949b594b1eca9` verified on Vercel and the active
      Railway worker, Broker and Signer. Worker auth succeeds and reads eight rows.
- [x] Owner selected Aster ceiling 125×. Not yet applied to production settings;
      ApeX ceiling remains 100× and actual venue symbol limits still apply.
- [x] Verify real scheduled Council opinions persist: at 2026-09-26 18:31 UTC,
      8 evaluated DeepSeek opinions and 16 unavailable GLM/Qwen opinions existed.
- [ ] Resolve GLM/Qwen provider HTTP failures; both returned Together HTTP 402 at
      2026-09-26 23:16 UTC while DeepSeek evaluated. Owner must check the Together
      organization behind the configured key for credit/spending-limit availability.
      This is not a fully healthy Council; do not lower quorum to conceal the outage.
- [x] Production plan controls use a service-only atomic operation with an audit;
      archive disables rows without deleting execution identities. No mode rewriting.
- [x] Local paper-loss and validation reads require explicit position-to-plan attribution;
      exclude mandates with live execution rows, including disabled live rows.
- [x] Local resume-paper control rejects live-linked plans and cannot rewrite row mode.
- [x] Paper entry authorization records the exact plan and composite connection/symbol
      route before the candidate opens. The database open function now preserves metadata.
      Historical positions without this evidence remain unattributed; no guessed backfill.
- [x] Per-plan schedule/row gates apply to scheduled and manual engine ticks; management
      continues for already-open positions. Ambiguous plan routes reject new entries.
      The database rechecks plan, row, schedule, scoped loss and configured entry caps.
- [x] Production legacy paper pause reconciled to `live_configured`, with old evidence
      retained in an audit. Four already-enabled live rows stayed unchanged. No arming,
      loss-limit change, leverage change or position action was performed.
- [x] Isolated PostgreSQL verification covers actual metadata persistence, unrelated-loss
      exclusion, stale entry rejection, audit-failure rollback, archive history and grants.
- [x] Correct the Live setup save handler's awaiting-approval label after configuration
      approval, without arming its rows. Production Aster's existing approval timestamp
      was preserved, status reconciled to live_configured and four armed rows unchanged.

Deployment follow-up: `happy-abundance` contains the authenticated production worker,
Broker and Signer. `positive-perception` also auto-deploys the repository but its worker
fails ingest signature verification and stays in demo. Do not provision that duplicate
with working signing credentials. Confirm ownership/use before removing the service.
Signed-in production verification showed both venue scans and the repaired ApeX plan;
it did not place a live test order or modify existing positions. Position protection
warnings remain real: the review desk reported two positions without visible stops.

Acceptance: capture fresh eligible decisions on each venue; reconcile their
intents and venue outcomes, including explicit refusal/no-trade reasons. Never
manufacture a signal to demonstrate success. Existing positions remain untouched.

## Stage 2 — traceable decisions and results

- [ ] Link decision → intent → all entry/exit orders → fills → position lifecycle.
- [ ] Use connection + account + venue identity; never infer authorship by symbol.
- [ ] Attribute net results to strategy/model/configuration version, including fees,
      funding and realized versus unrealized P&L.
- [ ] Show every scoped stage, freshness and failure; no silent error-to-empty mapping.

Acceptance: trace a trade end to end and explain why each unfilled candidate was
rejected, waiting, or ambiguous. Venue activity alone is not proof of Onyx authorship.

## Stage 3 — continuous trade and portfolio management

- [ ] Event-driven reviews of thesis, volatility, liquidity and reversal evidence.
- [ ] Typed hold/reduce/protect/exit recommendations, bounded by owner authorization.
- [ ] Independently working venue protection, restart recovery and duplicate handling.
- [ ] Cross-wallet capital, pending-order exposure and correlated risk accounting.
- [ ] Reinvestment based on reconciled balances and explicit owner allocation rules.

Acceptance: simulated timeout, partial fill, stale feed, provider outage and worker
restart cannot create duplicate exposure or falsely report confirmed protection.

## Stage 4 — measured improvement

- [ ] Versioned evidence/outcome dataset, including missed opportunities and correctly
      avoided losses; record what was known at decision time to prevent hindsight leakage.
- [ ] Cost-aware walk-forward evaluation and untouched out-of-sample periods.
- [ ] Compare candidate changes with the incumbent, report uncertainty and sample size.
- [ ] Shadow evaluation, controlled promotion, drift alerts and rollback.

Acceptance: improvements survive unseen periods after costs. Higher win rate alone
does not qualify a change; compare expectancy, drawdown and tail losses as well.

## Stage 5 — early on-chain activity and new venues

- [ ] Historical baselines for activity acceleration versus relatively quiet price.
- [ ] Unique-wallet participation, repeat accumulation, liquidity changes and confidence.
- [ ] Token sellability, holder concentration and manipulation checks before routing.
- [ ] Per-venue capability matrix before SynFutures, Kraken or another chain is called live.
- [ ] Arbiter arbitrage and early-token strategies remain separate and independently tested.

Current DEX discovery provides pair liquidity, volume, transaction counts and price
change. It is not unique-wallet accumulation detection or a prediction of a breakout.

## Removal policy

Delete only after repository-wide reference inspection and scoped regression tests.
Keep historical migrations, audit data, active integrations and recovery paths.
Do not delete safeguards to conceal refusals. Untracked `contracts/` belongs to
ongoing SynFutures work and is outside this cleanup.

## Verification limitations

Supabase's SQL query tool rejected the rolled-back insert-based RLS test because
its transaction is read-only. No test opinions were persisted. Catalog verification
confirmed RLS enabled, owner SELECT policy, no anon read/client write privileges,
and service INSERT. A role-isolated integration test remains required for release
hardening; catalog checks are not claimed as an end-to-end owner-session test.
