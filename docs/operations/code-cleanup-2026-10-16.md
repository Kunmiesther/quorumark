# Unused-code cleanup — 2026-10-16

## Scope and preservation

This is a cleanup, not a redesign, strategy change, account reset, or trading
activation. No production setting, balance, position, order, saved plan, or
loss limit is changed. No live order is used as a test. A separately authorized
database cleanup removed only expired paper-tick coordination leases; see
`database-cleanup-2026-10-16.md`.

## Removed

- Six disconnected `src/components/home-cinematic` modules (958 lines).
  Repository-wide reference checks found only references within that tree.
  The active homepage has its own implementation, including its own
  `MeetTheTurtles` function; it does not import the deleted component.
- Unreferenced `src/integrations/lovable/index.ts` login wrapper (38 lines).
  The current authentication flow and MCP implementation are retained.
- Seven direct dependency declarations: `@lovable.dev/cloud-auth-js`,
  `@react-three/drei`, `@react-three/fiber`, `@types/three`, `gsap`, `lenis`,
  and `three`. The npm lockfile removes 51 package entries and restores three
  missing optional peer entries required by npm 10's clean installer, with
  **no retained package version changes**. The strict Linux browser job caught
  this lockfile inconsistency; it was repaired with CI's npm version rather
  than bypassing `npm ci`.
- The redundant root `bun.lock`. Root CI and Vercel already explicitly use
  npm. Use `npm ci` with `package-lock.json` as the root dependency source
  of truth; broker and contracts retain their separate npm lockfiles.
- A `BotControlCard` position query whose result had no consumer, including
  no other consumer of its React Query cache key.
- Unused UI constants, derived values, import, and uncalled header helper.
- Paper-tick zone/VWAP calculations whose results had no consumer. The
  underlying strategy implementations remain. Removed unused diagnostic
  assignments without changing the fail-closed return paths.

Git history retains deleted source files for recovery. Nothing was reset.

## Deliberately retained

- Active build tooling, MCP routes, and authentication integrations.
- All ApeX/Aster adapters, order identity/idempotency, reconciliation,
  protection, P&L accounting, and risk checks.
- SynFutures and blockchain code, existing routes and compatibility redirects.
- Migrations, tests, historical ledgers, assets, styling, and current UI.
- `arc_preview`: a standalone deployment is not proved unused merely because
  the main app does not import it. No remote deployment was deleted.

## Test harness simplification

Vitest now has two explicit projects: `app` uses jsdom and `broker` uses Node.
Fastify broker tests previously inherited the browser environment. Both remain
part of `npm test`; no test files are excluded by this change.
CI uses a strict `npm ci` install and the verified single-worker, verbose
regression command. A newer commit cancels the obsolete regression run for
the same branch/PR, avoiding duplicate CI consumption.

## Verification

- All surviving JSX blocks in the six edited active TSX files match the
  original source exactly. No CSS or asset files were edited. This is source
  preservation evidence, not a substitute for browser visual testing.
- 96 broker tests passed with mocked signer responses.
- The final focused run, using the committed app/Node project split, passed
  **310 tests in 43 files** (including those 96 broker cases). Coverage includes
  paper sign-in intent, shared trading UI and unchanged palette, symbol choice,
  paper exits, manual paper submission, campaign sizing, venue-specific position
  evidence, TP/SL display, and broker routing/authentication.
- 140 focused signer tests passed using fake venue clients. Local Python is
  3.12 and the unavailable ApeX SDK uses the repository's fail-on-use test
  stub; this does not verify production cryptographic signing.
- 196 worker tests passed for signal/decision routing, strategy ownership,
  live wiring, and the accumulator bridge.
- Isolated PostgreSQL checks passed for Aster lifecycle and ownership,
  28 closed-position P&L cases, 31 ApeX order-recovery cases, 24 venue-reported
  P&L cases, and autopilot book/loss/archive isolation. No production DB writes.
- Application and broker TypeScript checks passed.
- Production build passed with placeholder backend configuration (no live
  credentials). Existing deprecated `inputValidator` warnings remain.
- JavaScript and raster-asset budgets pass. CSS decreased from 311.95 kB to
  309.39 kB, but remains 302.1 KiB against the existing 300 KiB budget. The
  budget was not raised and no style rules were removed to hide this warning.
- The full regression run now passes: **304 files / 2,588 tests passed**, with
  3 files / 44 explicitly skipped tests. Node 22, one worker and verbose output
  completed in 336.70 seconds. The prior interrupted attempts are superseded
  by this completed run; skipped tests are not recorded as verified.
- Additional SynFutures coverage: **111 signer tests** and **27 worker tests**
  passed. Isolated DB tests passed 36 admission, 33 lifecycle, and 19 activation
  scenarios, plus journal/replay, setup/ownership and account-context checks.
- Authoritative Python 3.11 signer CI passed on cleanup commit `1734b8e`,
  including hashed dependencies and the actual pinned ApeX/zkLink SDK (run
  `38936354016`). No signer source changed in subsequent lockfile repairs.
- Production read-only checks: signer `/healthz` returned `ok: true`, with
  ApeX/Aster automation flags enabled and live-test mode false; the public
  welcome page returned HTTP 200. These do not prove account eligibility,
  execution, exchange acceptance, or a completed trade.

## End-to-end limitation

The local welcome HTTP route returned 200. Browser execution could not be
verified locally: both installed Chrome and Playwright's independent headless
shell are blocked by macOS process permissions (`bootstrap_check_in ...
Permission denied`). The in-app browser accessibility request also timed out.
A credential-free Linux CI smoke test now covers welcome rendering and the
signed-out guards for paper, live, and exchange pages. It uses placeholder
configuration and blocks browser requests to external hosts.

No signed-in UI-to-real-venue round trip was completed. Mocked execution and
isolated-ledger tests do not prove production trading readiness or clear
account-specific blockers.

Read-only production checks on October 16 found:

- All three connection records remain verified with trading flags enabled.
- ApeX's existing plan records -316.95600368 P&L and four unknown closures;
  Aster's records -435.06291268 and zero unknown plan closures. Both retain
  the existing 25.00 loss limit. No losses or limits were reset.
- SynFutures has intermittent monitor failures but also current successful
  monitor responses. The 16:54 UTC snapshot shows the module enabled, 125 USDC
  reserve, zero margin spent, and flat BTC/ETH positions. However, operator
  authorization has expired (`operator_exit_available=false`). The database's
  live flag is not proof of an authorized on-chain session. No campaigns or
  transactions have been recorded. Owner wallet renewal is required; this
  cleanup does not sign a renewal or activate trading.

Cleanup does not resolve or bypass existing historical order uncertainties or
saved-plan loss limits. Deployment and a signed-in read-only smoke check are
separate from this local change.
