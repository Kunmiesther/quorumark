# Paper and blockchain repair — 2026-09-27

## Implemented locally; deployment still required

- Paper campaign stop resolution now prefers the persisted armed stop. Fallback
  reconstruction uses cumulative filled rungs and the frozen final-rung price,
  never the number of lots remaining after TP. Entry/arming thresholds and the
  existing candle-close stop trigger are unchanged.
- Paper performance counts completed positions, summing every partial realization.
  Both performance consumers share the calculation. Production has no FK from
  paper_trades.position_id to paper_positions, so the loader explicitly reads
  parent positions and paginates their exits, scoped to the authenticated user.
  No historical trade or P&L rows were changed.
- Sniper/sweep and other public Turtle/detector aliases match paper authorization.
  Vanguard candidates retain their identity; new positions persist detector
  metadata even when execution uses the shared DCA wallet. Historical rows are
  not retroactively assigned a guessed strategy.
- Paper selection no longer uses live subscription entitlements. This does NOT
  mean every advertised Turtle has a complete execution implementation (see below).
- Direct GLM transport is prepared for Z.ai. Server-only TURTLEBOT_ZAI_API_KEY
  selects it; TURTLEBOT_GLM_PROVIDER=zai explicitly selects it even without a key
  and reports unavailable rather than falling back to Together. Optional
  TURTLEBOT_ZAI_MODEL defaults to glm-5.3. Qwen remains independently on Together.
  No key has been supplied, no environment was switched, no paid API test was made.
- Spread-arbitrage paper math reserves entry AND unwind fees/slippage on both
  legs, rejects nonfinite/invalid inputs, and recognizes a zero-crossed spread
  as convergence. Positive tests now actually enable and exercise the evaluator.
  The production feature flag remains unchanged.
- Existing Base/BNB custom-token purchase preparation now requires a full-size
  reverse quote at the same block and a cleared GoPlus contract-risk report.
  Missing/failed evidence blocks new purchases; it is not interpreted as safe.
  Taxed transfers are unsupported by the current v3 router. The same checks run
  again after Council review. Selling existing holdings is not subjected to
  new-entry screening. Only public chain/contract identifiers go to GoPlus.

## Verification

- 761 JavaScript tests passed, 3 skipped across paper, Arbiter, committee,
  blockchain, paper authorization/runtime and completed-position accounting.
  Skips include opt-in public-chain checks; no public RPC execution test is claimed.
- 88 Python tests passed across Aster campaign/executor, shared campaign planning,
  ApeX execution paths and message serialization. Tests use mocks; no order sent.
- Read-only production schema inspection confirmed the missing paper-trade FK.
- Desktop/mobile visual comparison and a production build have not been completed.
  Local free storage was about 309 MiB; avoid installing dependencies or producing
  another large build until storage is available. Existing styles were not edited.

## Remaining work — do not report these as operational

1. Arbiter funding/spread modules are not wired into the worker's durable paired
   execution lifecycle. Executable bid/ask quotes, funding/inventory per venue,
   gas/borrow costs, partial-fill recovery and two-leg reconciliation are needed.
   Pure evaluator tests do not constitute live arbitrage support.
2. An autonomous new-token discovery -> decision -> buy -> position management
   strategy is not implemented by these entry guards. A pool reverse quote does
   not execute ERC20 sell transfers and is not a honeypot proof. Full wallet-
   specific buy/sell sequence simulation and durable exit monitoring are still
   required. A security report cannot guarantee future liquidity or sellability.
3. Paper plans still share user_strategy's user/connection/symbol uniqueness with
   live plans. Existing live rows can conflict with paper configuration. Resolve
   book isolation across schema, plan controls, runtime and UI atomically; never
   overwrite or pause a live row merely to create a paper comparison.
4. Backtest stop semantics differ: the historical script uses intrabar high/low
   touches, while the owner-ratified paper engine uses completed candle closes.
   Backtest success is not proof of paper parity. A matched-event replay is needed.
5. Direct Z.ai activation awaits the owner's general-API key (not a Coding Plan
   endpoint). Store it only in server secrets, then test provider availability.
6. Production deployment and signed-in verification remain outstanding. No live
   authorization, leverage, positions, orders or wallet credentials were changed.

Official references:
- https://docs.z.ai/api-reference/llm/chat-completion
- https://docs.gopluslabs.io/reference/tokensecurityusingget_1
- https://docs.gopluslabs.io/reference/response-details
