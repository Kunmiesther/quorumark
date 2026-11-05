# TurtleBot — NEAR Hackathon Fit & Technical Audit

**Repository:** `C:\Users\USER\turtle-bot-dashboard`  
**Revision:** `54bf61cb` on `main` (2026-10-16; clean working tree at audit start)  
**Method:** read-only inspection. No dependencies installed, migrations run, production systems contacted, transactions executed, secrets exposed, or application files changed.

## Executive summary

TurtleBot is a financial-automation product presented as “AI on the side of everyday people.” In judge-friendly terms, it helps a user map bills and goals, connect wallets/trading accounts, configure a set of strategy “Turtles,” simulate or monitor trading, and receive structured advice from a three-seat AI committee.

This is substantially more than a UI prototype: the tree contains a React/TanStack web app, Supabase database/auth/edge functions, Python market and strategy workers, a Railway execution broker, a private signer, paper-trading state machines, exchange adapters, smart-contract candidates, mobile shells, CI, and many tests. It is not a finished public production product, however. The most important finding is that **no NEAR integration is present**: no NEAR SDK, account, contract, RPC client, Intents, Chain Signatures, NEAR AI, or NEAR-native payment/identity flow was verified.

**Verdict: CONDITIONAL FIT.** Extending TurtleBot is more practical than starting over if the team adds one narrow, testnet-first NEAR feature in an isolated module. The strongest opportunity is a NEAR-controlled, policy-limited agent treasury or swarm quorum that turns the existing AI recommendations and safety controls into auditable, user-approved onchain actions. The strongest track is **AI Swarms**, with **Agent Economy** and **Autonomous Business** as credible alternatives. A wallet button, token, or unverified claim of autonomous trading would be weak.

Confidence is high for repository findings and medium for deployment/readiness findings: this audit did not run the app or connect to deployed services, and the repository’s own documents distinguish local implementation from operational production state.

## 1. Product discovery

### What it solves and who it serves

TurtleBot addresses fragmented financial context (goals, bills, wallets, venues and market data), difficult-to-audit trading automation, and the gap between an AI recommendation and a safe financial action. Intended users visible in code are:

- Retail users managing goals, bills, paper portfolios, wallets and strategies.
- Advanced users connecting ApeX, Aster, SynFutures and supported wallets.
- Operators managing live-readiness, signers, users, communities, campaigns and AI usage.
- Community leaders/members using invitations, competitions, Telegram linking and entitlements.

The marketing page explicitly presents a Life Map, Onyx planning, Turtle strategy roles and trading as one tool for funding life (`src/routes/index.tsx:29-33`, `src/routes/index.tsx:160-181`).

### Core features verified

- Life Map bills, allocations, goals and progress (`src/routes/_authenticated/life-map.tsx`, `src/components/lifemap/`, `supabase/migrations/20260907184059_restore_life_map_billing_schema.sql`).
- Supabase authentication, onboarding, profile and subscription (`src/hooks/useAuth.ts`, `src/routes/_authenticated/route.tsx`, `src/routes/welcome*`).
- Paper accounts, wallets, positions, rung fills, operations, leases and risk events (`docs/PAPER_ENGINE_ARCHITECTURE.md`, `supabase/migrations/20260908182229_restore_paper_engine_runtime.sql`).
- Trading desk, performance, strategies, decision timelines, committee reviews and automation observability (`src/routes/_authenticated/trade.tsx`, `src/components/trade/`, `src/components/automation/`).
- Turtle roles: Accumulator, Vanguard, Sniper, Hunter, Scout and Arbiter. The repository says Accumulator is selected on audited live rows; catalog presence is not proof of live execution (`docs/blockchain-and-synfutures-status.md`).
- Scout market/blockchain discovery using DEX Screener for Base, BNB Chain and Solana (`docs/blockchain-discovery.md`).
- Wallet/exchange desks, ownership verification, balance reads, Base/BNB quote/preflight and SynFutures setup/quote (`src/components/exchanges/`, `src/lib/blockchain/spot.ts`).
- AI council/advisory, model credential management, AI usage, Onyx and autopilot planning (`src/lib/ai/committee/`, `supabase/functions/autopilot-plan/`, `supabase/functions/llm-credentials/`).
- Communities, Telegram, notifications, push tokens, campaigns and Capacitor Android/iOS shells.

### Main user journey

1. User visits marketing/onboarding, signs in through Supabase, and completes onboarding. The authenticated route redirects incomplete users back to onboarding (`src/routes/_authenticated/route.tsx:6-62`).
2. User creates/reviews Life Map goals and bills, then connects an exchange and/or owned, verified wallet.
3. User inspects markets and configures a plan in Home, Scout, Trade, Strategies, Paper, Automation or Agentic surfaces.
4. Autopilot validates status, capital/loss limits, symbols, Turtle entitlements, schedule and execution settings (`supabase/functions/autopilot-plan/index.ts`).
5. Paper decisions/fills can be simulated. Live routes, where enabled, pass worker → authenticated broker → private signer → venue with safety and reconciliation (`docs/CONNECTIVITY_AUDIT.md`).
6. AI opinions review recorded decisions, but the advisory route is deliberately post-hoc and non-blocking; it cannot veto or submit a trade (`src/routes/api/public/hooks/ai-advisory.ts`).

### Differentiation and maturity

The differentiated idea is a life-goal-aware command center combining character-based strategies, paper/live separation, multi-venue controls and traceable AI review. This is more ambitious than a charting terminal, but the differentiator is currently centralized and not NEAR-native.

**Maturity: working product foundation with incomplete and operationally gated subsystems.** The many routes, data models, workers, broker/signer boundary, CI and tests show real implementation. Conversely, the repository says SynFutures remains undeployed/not connected, spot execution is still non-executable, deployment parity is required, and configuration is not proof of fills or profitability (`docs/blockchain-and-synfutures-status.md`, `docs/blockchain-discovery.md`, `docs/CONNECTIVITY_AUDIT.md`).

## 2. Technical architecture

| Area | Verified implementation |
|---|---|
| Frontend | React 19, TypeScript, TanStack Start/Router, Vite, Tailwind, Radix UI, Framer Motion, React Query and Recharts (`package.json`, `src/`). |
| Mobile | Capacitor with Android and iOS projects (`capacitor.config.ts`, `android/`, `ios/`). |
| Web backend | TanStack Start server routes and Vercel deployment (`src/server.ts`, `src/routes/api/`, `vercel.json`). |
| Data/auth | Supabase Postgres, Auth, RLS, migrations, RPCs and Edge Functions (`supabase/migrations/`, `supabase/functions/`). |
| Worker | Python market/strategy/orchestration code (`bot_worker.py`, `worker_live_wiring.py`, `requirements.txt`). |
| Broker | TypeScript/Node Railway service (`broker/src/`, `broker/Dockerfile`, `broker/README.md`). |
| Signer | Python Railway service for ApeX signing, intended to remain private (`signer/`, `signer/Dockerfile`, `signer/README.md`, `railway.toml`). |
| Contracts | Solidity/Foundry SynFutures account/module candidate (`contracts/synfutures/`). |
| Blockchain libs | `viem`, MetaMask Connect EVM, WalletConnect and `@synfutures/perpv3-ts`; no NEAR dependency in `package.json`. |
| Deployment | Vercel web/crons, Supabase, Railway broker/signer and worker (`vercel.json`, `railway.toml`, `Procfile`). |

The relational model covers profiles/roles/subscriptions; exchange connections/credentials; wallets and verification; strategies, decisions, candidates, intents, fills, positions and P&L; paper accounts/wallets/positions/trades/leases; autopilot workflows/risk/capital reservations; AI credentials/council/evaluations; Life Map bills; communities, competitions and Telegram. Representative migrations: `20260903143000_user_llm_credentials.sql`, `20260905203820_user_ai_council.sql`, `20260906000450_autopilot_workflows.sql`, `20260908182229_restore_paper_engine_runtime.sql`, and `20260908063239_restore_community_campaign_foundation.sql`.

Authentication uses Supabase sessions. `src/hooks/useAuth.ts` restores sessions with a timeout; `src/routes/_authenticated/route.tsx` checks `getUser()` and onboarding; edge functions validate bearer tokens and scope writes to the user (`supabase/functions/autopilot-plan/index.ts`, `supabase/functions/llm-credentials/index.ts`). Migrations repeatedly enable RLS and define owner/admin/member policies. Live execution adds separate owner/browser, worker/broker, broker/signer and venue gates.

External integrations include Supabase, Vercel, Railway, ApeX Omni, Aster, SynFutures, DEX Screener, Base/BNB RPC, CoinGecko/news, Telegram, WalletConnect/MetaMask and multiple LLM providers. The intended topology and deployment prerequisites are documented in `docs/CONNECTIVITY_AUDIT.md` and `railway.toml`.

Build/test configuration is broad: `package.json` includes build, lint, Vitest, mobile and performance commands; CI covers TypeScript, browser smoke, broker, worker, signer, SynFutures/Foundry and regression tests (`.github/workflows/`). Tests were not run because the request prohibited dependency installation and broader execution. They do not prove production deployment, funded execution, profitability or NEAR compatibility.

## 3. AI and automation

Yes, TurtleBot uses AI. The primary feature is a three-seat committee: lead trade thesis, adversarial risk officer, and market structure/liquidity (`src/lib/ai/committee/providers.server.ts:44-128`). Structured opinions include direction, confidence, summary and risk flags; records include latency, prompt version and evidence hash (`src/lib/ai/committee/decisionEvaluate.server.ts`).

Users can configure providers/seats. `supabase/functions/llm-credentials/index.ts` checks AI consent, stores provider keys through server-side RPCs, and returns only summary metadata/key suffixes. The provider adapter includes OpenAI-compatible, Anthropic, Google/Gemini, DeepSeek, Zai/Qwen, Together, OpenRouter and Lovable gateway paths (`src/lib/ai/committee/providers.server.ts:27-38`).

The AI advisory route is **advisory only**: its comments and code say it has no route to the worker, broker, signer or ApeX; it writes opinions and consolidation records and does not submit orders (`src/routes/api/public/hooks/ai-advisory.ts`). Autopilot is separate: its LangGraph flow validates proposals and safety fields (`supabase/functions/autopilot-plan/index.ts`), while deterministic workers perform financial routing.

| Capability | Status |
|---|---|
| Three-seat structured AI opinions | Implemented; provider availability depends on config. |
| User AI key/council management | Implemented with consent and server-side RPCs. |
| Scheduled post-hoc AI advisory | Implemented. |
| LangGraph autopilot proposal validation | Implemented. |
| AI autonomously deciding and submitting trades | Not verified; advisory path is explicitly blocked from doing so. |
| Agents with independent onchain identities/tools | Not present. |
| NEAR private AI | Not present. |

Automation itself is substantial: scheduled hooks, a Python worker, broker, signer, safety checks, risk limits, kill switches and reconciliation. It is inaccurate to describe the current AI as an autonomous trading swarm with direct financial authority.

## 4. Blockchain and financial capabilities

| Capability | Actual finding |
|---|---|
| Crypto wallets | Partial/implemented for owned EVM and related records, connection and verification. |
| Payments/transfers | Capital-flow/exchange transfer concepts exist; user-confirmed deposits/withdrawals are outside autonomous operation. No NEAR payment. |
| Token swaps | Partial. Base/BNB Uniswap v3 quote/preflight and calldata compilation exist in `src/lib/blockchain/spot.ts`; docs say no executable transaction is exposed and `executionReady` remains false. |
| Cross-chain | No verified generic execution. Network discovery is not execution. |
| Trading | Paper trading is substantial. ApeX/Aster live paths exist behind strict gates; docs require deployment/proof/reconciliation before calling them operational. |
| Treasury | Partial through authorized capital, loss limits, campaign admission and capital flow; no onchain treasury. |
| Financial automation | Strongest existing capability: deterministic strategy/worker/broker/signer automation with paper/live separation. |
| Onchain identity | Wallet ownership/verification exists; no NEAR account or agent identity. |
| NFTs/tokens/memecoins | Marketing routes/assets exist (`src/routes/nfts.tsx`, `src/routes/presale.tsx`), but no verified functional NEAR economy. |

SynFutures is an integration candidate, not live proof: `contracts/synfutures/README.md` and `docs/blockchain-and-synfutures-status.md` say the module remains undeployed and disconnected from the production worker.

## 5. NEAR track compatibility

Effort assumes one experienced full-stack/blockchain engineer, testnet scope, and no production-money requirement.

| Track | Fit / reusable base | New work and NEAR technology | Effort / risks |
|---|---|---|---|
| Unstoppable DeFi | Weak-to-conditional; wallet/preflight, risk limits, paper execution | NEAR Intents or Chain Signatures, policy vault, settlement/reconciliation | 2–4 weeks; signing, liquidity, slippage, contract/testnet risk. |
| Investment Thesis | Conditional; Life Map goals, signals, AI committee, evidence hashes | Onchain thesis commitments and outcome attestations | 1–2 weeks; hash-only utility is weak. |
| Privacy & Private AI | Conditional/strategic; AI consent and evidence scoping | NEAR AI/private inference or TEE path, encrypted policy data, selective disclosure | 2–4+ weeks; availability and privacy claims. |
| Autonomous Business | Conditional/strong; autopilot, capital limits, worker/broker/signer | NEAR treasury/policy contract and optional Intents settlement | 2–4 weeks; must show a credible business action. |
| AI Swarms | **Strongest**; three-seat council, Turtle roles, scheduled structured opinions | Agent identities/contracts, quorum/task/result receipts, optional NEAR AI agents | 1–3 weeks for receipts; 3–6 for true autonomous agents. Must prove coordination. |
| AI Security & Defense | Conditional; safety checks, kill switches, signer isolation, audit logs | Onchain policy/approval registry and action attestations | 2–3 weeks; threat model/adversarial tests required. |
| Agent Economy | **Strongest integration**; AI seats, communities, entitlements, automation | NEAR identity, escrow/payment rails, task marketplace/pay-per-action, Intents/Chain Signatures | 2–4 weeks; economics, refunds, abuse and identity. |
| Real-World Money | Conditional/risky; bills/goals, allocations, wallets | Testnet stablecoin goal/treasury settlement and receipts | 3–6 weeks; compliance, custody, fiat/offramp. |
| Games With Real Economies | Weak; characters and competitions only | Complete game loop, NEAR ownership and rewards | 4–8 weeks; current UX is not a game loop. |
| NFTs That Do Something | Weak-to-conditional; characters/collectibles/strategy concepts | Functional NEAR NFT for permission, license or reputation | 2–4 weeks; utility must be essential. |
| Memecoins With Mechanics | Not suitable; characters only | New token/economy product | 4–8+ weeks and security/economic risk. |
| Social Money | Conditional; communities, competitions, invitations, Telegram | NEAR group treasury/shared goals/reward settlement | 2–4 weeks; social loop and anti-sybil/privacy. |
| Open Innovation | Conditional; broad surface | One novel NEAR primitive with end-to-end proof | 2–4 weeks; scope discipline. |

NEAR’s public materials describe Chain Signatures as allowing NEAR accounts/contracts to sign across other chains, NEAR Intents as a cross-chain intent/liquidity protocol, and NEAR AI as a user-owned/verifiable AI/private-inference direction. These inform planning only; none is in this repository and current API/testnet maturity must be confirmed before implementation.

## 6. Existing product vs. hackathon work

The reusable baseline is the authenticated dashboard, Life Map, AI committee ledger, autopilot validation, paper engine, wallet verification, safety/control surfaces and audit trail. The cleanest hackathon slice is a new testnet-only “NEAR Agent Treasury” or “NEAR Swarm” route recording agent identity, policy version, proposal hash, approval, NEAR transaction/intent ID, receipt and reconciliation status.

Keep it under a new route/component/adapter namespace. Do not alter live trading authority, signer behavior or production flags. Capture baseline screenshots and tests from `54bf61cb`, then show: current AI advisory → NEAR policy/quorum → explicit approval → bounded testnet action → TurtleBot receipt.

Git history supports comparison: `main` is clean at `54bf61cb`, with dated feature commits and many focused remote branches, but no useful release tags were visible. `AGENTS.md` warns that the project is Lovable-connected; do not rewrite published history.

Access does not prove redistribution/publication rights. The top-level listing showed no root `LICENSE`; the tree contains third-party brand/source/license notes (`src/assets/brand/*/SOURCE.md`, `src/assets/brand/*/LICENSE.md`), vendor SDKs and assets, and multiple contributor/automation identities. Obtain written permission for public source/demo use, trademarks, logos, generated art, third-party assets and architecture disclosure. Do not publish credentials, private keys, customer data or confidential deployment information.

## 7. Three compelling NEAR extensions

### A. Turtle Swarm — verifiable multi-agent risk council

**Problem:** TurtleBot has three AI seats, but a judge cannot tell whether this is a real coordinated swarm or three answers displayed together. **Solution:** give thesis, risk and structure explicit roles; feed them the same evidence hash; submit structured opinions/proposal digest to a NEAR contract; require quorum plus human approval before a testnet action. **UX:** select symbol/budget, watch parallel deliberation, inspect disagreement/evidence, approve and see receipt. **NEAR:** durable identity, tamper-evident proposal order, quorum/result receipts. **Why necessary:** independently verifiable coordination and enforceable quorum. **Demo:** remove a seat, show quorum fail; alter evidence, show hash mismatch; approve safe testnet action. **Buildability:** 1–3 weeks; keep production trading disconnected.

### B. NEAR Agent Treasury — bounded autonomous business actions

**Problem:** TurtleBot can set capital/loss limits, but agents have no onchain user-owned budget with enforceable spending rules. **Solution:** testnet treasury with allowed agents/actions, per-action and daily caps, expiry, emergency pause and approval threshold. First action should be a testnet allocation/payment, not a real trade. **UX:** create goal, fund testnet treasury, set limits, review proposal, approve, see receipt and updated goal. **NEAR:** contract-enforced ownership/policy; optional Chain Signatures/Intents stretch. **Why necessary:** rules and balances remain enforceable outside the web database. **Demo:** success, daily-limit rejection, expiry rejection and emergency pause. **Buildability:** 2–4 weeks.

### C. Life Map cross-chain intent allocator

**Problem:** goals exist while assets sit on different networks; current Base/BNB flows are quote/preflight only. **Solution:** choose a goal and approve a bounded testnet intent with quote/fees/minimum output, settle through NEAR Intents or a NEAR-controlled account, and reconcile exact results. **NEAR:** intent/liquidity and possibly Chain Signatures. **Why necessary:** the chain action is the product and needs verifiable settlement. **Demo:** stale quote rejected, bounded transfer succeeds, receipt updates goal. **Buildability:** 3–6 weeks and higher risk due to provider/solver/testnet availability.

## 8. Readiness and risks

**Strengths:** clean separation of web/database/worker/broker/signer; explicit paper/live distinction; broad tests/CI; AI evidence hashing; wallet ownership and quote validation; strong operational documentation.

**Risks/blockers:** no NEAR code; worker/broker/signer deployment parity is still required; spot and SynFutures execution are partial; real-money authority makes security scope sensitive; AI is advisory, not autonomous trading; multiple runtimes and external services reduce reproducibility; local setup requires Supabase, Python, broker/signer, secrets and external accounts; tests do not prove deployment, profitability or NEAR; public release needs sanitized data, testnet wallets, pinned contracts and a demo harness; review RLS, service-role edge functions, cron auth, logs, provider retention, browser bundles and third-party licenses before publication.

| Dimension | Assessment |
|---|---|
| Product foundation | Strong |
| Paper/demo readiness | Strong, subject to environment setup |
| Live financial readiness | Conditional and operationally gated |
| Existing NEAR readiness | None verified |
| AI readiness | Strong advisory foundation; weak autonomous-agent claim |
| Public reproducibility | Medium-low without sanitized harness |
| Hackathon extension feasibility | Good if testnet-scoped |

## 9. Final assessment

**Product summary:** a goal-aware AI-assisted trading and financial automation platform with a polished consumer experience and serious backend safety/operations architecture. Its strongest proof is deterministic paper/live infrastructure plus traceable, non-executing AI review. Its weakest proof is decentralized ownership, NEAR integration and autonomous agent execution.

**Strongest track:** AI Swarms. **Strongest integration:** a NEAR identity/quorum/policy layer for the existing AI committee, ideally extended into a bounded Agent Economy treasury/payment demo. **Complexity:** medium for swarm receipts (1–3 weeks), medium-high for treasury (2–4 weeks), high for cross-chain intents/signing (3–6 weeks). **Major blockers:** no current NEAR code, production-safety scope, reproducible testnet demo, and company/asset publication rights.

**Extend or restart:** extend TurtleBot in an isolated testnet module. Starting over would discard the existing committee, paper engine, Life Map, safety controls, UI and operational evidence. Reusing the full live trading path would create avoidable scope and security risk.

### Verdict: CONDITIONAL FIT

TurtleBot becomes a credible NEAR submission only if NEAR enforces or attests to something the centralized system cannot credibly provide—agent identity, quorum, treasury policy, cross-chain settlement, privacy or verifiable receipts. A wallet button, token, or unverified “autonomous trader” claim is not sufficient. If that boundary cannot be demonstrated on testnet by November 14, do not present TurtleBot as a NEAR-focused submission; a smaller new NEAR-native project would be safer and more honest.

## Official NEAR references used for planning

- [NEAR Chain Signatures overview](https://near-horizon.notion.site/Chain-Signatures-4e919cf57f93472f9a6e89bf29581a02?pvs=21)
- [NEAR Intents](https://intents.near.org/)
- [NEAR AI](https://near.org/ai)
- [NEAR AI Agents quickstart](https://github.com/nearai/nearai/blob/main/docs/agents/quickstart.md)
- [NEAR Chain Abstraction](https://www.near.org/chain-abstraction)

These links inform proposed integrations only. They do not establish that the audited repository already uses any of them.
