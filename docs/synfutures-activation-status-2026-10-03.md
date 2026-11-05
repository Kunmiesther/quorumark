# SynFutures activation work — 2026-10-03

SynFutures is not activated. The registered Base Safe/module exists. The latest
scheduled on-chain observation at 14:55 UTC recorded zero unallocated Gate
collateral, disabled module, no authorized operator session, and disabled market
entries. The saved allocation is $100 and the saved leverage ceiling is 33x.
This is configuration, not trading authority or a verified funded account.

## Implemented in this change

The signer now has a reusable Base module submission core. It validates exact
ABI integers, chain, operator identity, pending nonce, active-session deadline,
simulation, gas bounds and operator balance before signing locally. It durably
reserves the signed hash through the existing owner-scoped transaction journal
before one broadcast attempt. Reservation failures and replays never grant
broadcast. Provider timeouts, mismatched returned hashes and failed observations
retain reconciliation-required state. Neither acceptance nor a hash is a fill;
the existing canonical-finality/event reconciliation is still required.

The core has no activation endpoint and is not dispatched by the worker. Its
account-verification and protective-exit prerequisites must be derived by a
private account adapter, never passed through a browser or worker payload.
Entries remain refused without those prerequisites. Raw signed bytes and private
keys never go through worker-ingest or the database.

The account reader also reads both supported markets' real positions at the same
verified Base block. Signed sizes preserve short exposure; unavailable reads
remain unknown and are never reported as flat. The owner UI displays these reads.

Readiness now distinguishes entry budget from operator exit authority. Exhausted
margin budget prevents entries but does not by itself prevent reductions. The
currently deployed v1 module requires a live session for reductions too: expiry,
revocation or disabling the module blocks operator exits. The UI makes this
explicit instead of implying a funded/authorized entry account has working exits.

## Still required before activation

1. An owned SynFutures exchange connection and dedicated operator key, account
   adapter verifying registration/code/session/positions on-chain, and reliable
   private RPC configuration.
2. Worker strategy candles and entry dispatch; exact quote-based sizing, venue
   minimums, per-market limits, aggregate exposure and durable campaign admission.
3. Tested position monitoring, protective exit dispatch, session-expiry handling
   and owner recovery. The immediate-trade module does not place native stop or
   limit orders. Do not accept unprotected entries merely because simulation works.
4. Owner-reviewed exact USDC funding/approval/deposit and Safe session calls, with
   operator address, market limits, budget, slippage, expiry and recovery displayed.
5. Base-fork end-to-end validation and deployed staging verification, followed by
   owner-authorized small mainnet entry/protection/exit receipts.

Current scope: futures remain BTC/ETH/SOL/XRP platform-wide; this deployed
SynFutures module supports BTC-USDC and ETH-USDC only. SOL/XRP need independently
verified instruments and a reviewed module change before execution. Spot and
direct blockchain discovery have no fixed four-symbol cap.

## Validation

Local submission and receipt-reconciliation tests: 40 passed, including 33
reconciliation subtests. Tests sign real EVM transactions using a test-only
account, but mock the venue/RPC; no live transaction was submitted. Account,
readiness and readiness-sweep tests: 28 passed. A separate actual read of the
registered Safe passed at Base block 52125617: zero Safe USDC, zero Gate allowance,
zero Gate reserve and zero BTC/ETH position size. No transaction was sent.

The broader local signer run passed 625 tests and failed eight unrelated
environment checks: the partial checkout lacks the pinned ApeX zk SDK and its
packaged parity JSON. This is not a claim that the complete production signer
suite passed locally. The first commit's dedicated submission CI and complete
signer CI passed remotely with the proper dependencies. The application CI
separately covers type checking, regression and build; final results must be
checked at the latest commit before deployment.
