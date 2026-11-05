# Turtle Bot — Invite-Only Community Platform

## What I found before planning

I inventoried the live database rather than assuming. Current state: 7 accounts, 7 profiles, 1 admin (`info@onixus.xyz`), 0 waitlist rows, 128 paper wallets, 7 subscription rows.

Three findings change the plan:

1. **The owner-only live boundary is intact.** `user_strategy.mode` (`paper`/`live`) is the real selector used by `active_bot_config`, and the owner-only trigger guards exactly that column. `order_intents` has a second, independent owner-only trigger, so real-money submission is blocked for non-admins even if a strategy row were misconfigured.
2. **But `user_strategy.market_type` is a misleading unguarded field.** One non-admin account currently has `market_type = 'futures'` with `mode = 'paper'`. That is *not* live eligibility — it is cosmetic drift — but it looks alarming in any audit and will look like a breach on the new admin dashboard. Worth normalizing as hygiene, called out separately below so it is never confused with the real gate.
3. **No Stripe or Paddle is connected, and `subscriptions` is `user_id / tier / status` only — no billing truth at all.** So section 6 is genuinely preparation-only. I will not create payment records, MRR figures, or a commission ledger with money in it. The commission ledger ships as a real, empty, append-only table with the webhook boundary stubbed and clearly inert.

## Scope reality

This is roughly eight tables, a full RLS tenant model, a canonical authority layer, two new dashboards, an onboarding flow, a grandfathering migration, and a large test matrix. It will not land safely in one pass, and pretending otherwise is how tenant-isolation bugs ship. I propose four phases, each independently verifiable. **You also asked me not to publish until the outstanding code-accuracy and agentic gates pass — those are still open** (5 pre-existing test failures in chart-styling and reconciler files, plus a production build I have not re-run). Nothing here publishes.

---

## Phase 1 — Data model and tenant isolation

One migration creating the eight tables with enums, uniqueness, and RLS from the start.

- `trading_communities`, `community_memberships`, `community_invitations`, `invitation_redemptions`, `community_commission_rules`, `community_commission_ledger`, `access_entitlements`, `community_audit_events`.
- Invitations store `token_hash` only (SHA-256 of a single-use random token). The plaintext token is returned exactly once from the creating server function and never persisted or logged.
- Idempotency: unique `(invitation_id, user_id)` on redemptions; `uses` guarded by a `CHECK (uses <= max_uses)` so oversubscription is a database error, not a race the app has to win.
- Every table gets GRANTs alongside RLS, matching the roles the policies actually allow.
- Isolation predicate goes in a `SECURITY DEFINER` helper (`is_community_leader(uuid)`) to avoid the recursive-policy trap already used elsewhere in this project.

## Phase 2 — Canonical server authority

One module, one entry point: `resolveAccess(userId)` returning paper / decision-room / agentic / live flags plus provenance.

- Every protected route and server function calls it. No route re-derives eligibility.
- Live always resolves from the existing admin check — the entitlement layer can never contribute a live grant. I will assert this in a test that fails if an entitlement row is ever able to flip live true.
- Leader capability checks: seat-limit-bound invitation creation and revocation, scoped to their own community, with self-approval, commission edits, role elevation, and cross-community reads all denied.
- Redemption is a single `SECURITY DEFINER` function doing validate-and-consume atomically under `SELECT ... FOR UPDATE`, expiration- and use-limit-aware.

## Phase 3 — Onboarding and the two dashboards

- Public marketing route stays public and SSR-on; waitlist CTA writes to the existing `waitlist_signups`.
- Invitation link → branded community welcome (name, logo, plan, expiry) → auth → redeem-after-auth → risk acknowledgement → canonical `ensure_paper_ready` provisioning → Paper Command Center with "Invited by [Community]".
- Every invalid state (expired, exhausted, revoked, suspended community, email-mismatch) gets its own accurate message and waitlist fallback. No generic "something went wrong".
- Community Command Center (leaders): funnel counts, seat usage, invite create/revoke, commission ledger, privacy-safe export. Aggregate metrics are suppressed below a minimum cohort size so a leader cannot deanonymize a single member's results.
- Onixus Control Center (admin): applications, approve/suspend/revoke, seats, plans, commission rules, audit history, invitation revocation.

## Phase 4 — Grandfathering, tests, proof

- Repeatable idempotent migration granting all 7 existing accounts paper entitlements, source `grandfathered`. No live. No deletions of history, credentials, or subscriptions.
- Test matrix exactly as you listed it, including the concurrency test (two simultaneous redemptions of a one-seat invite — one wins, one is denied) and the RLS isolation tests run as two distinct leader identities.
- Typecheck, full suite, production build.

---

## Technical notes

Plans live in a `plans` config module, not scattered literals: Free Paper Trial, Scout, Agentic, Pro, Fusion. Entitlement mapping references plan keys; billing truth stays wherever the provider eventually puts it.

LLM cost attribution: the existing `paper_ai_orchestrations` rows carry per-trace model usage, so attribution joins on entitlement without new telemetry.

The commission model is fixed-amount or approved-percentage of collected subscription revenue only. No profit-, deposit-, or volume-based compensation path exists in the schema, so it cannot be configured later by accident.

## Open questions

1. **Community application intake** — should communities self-apply through a public form, or does Onixus create them manually at first? I have assumed a public application form writing an `applied` row that only admin can approve.
2. **Grandfathering tier** — I have assumed all 7 existing accounts get Free Paper Trial, not a paid tier. Say if the admin or specific accounts should get more.
3. The `market_type` drift in finding 2 — normalize it as part of Phase 1, or leave it alone?
