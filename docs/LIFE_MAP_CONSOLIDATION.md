# Life Map Consolidation

Owner-directed consolidation pass. Life Map v2 (`bills` + `bill_allocations`)
is now the **only** source of truth for Life Map surfaces. The legacy
`life_obligations` / `life_categories` / `bill_payment_intents` /
`earnings_allocations` / `point_ledger` reads are gone from all rendered UI.

## What changed

- `src/components/home/LifeProgressCard.tsx` — rewritten. Reads
  `getLifeMapSnapshot` + `listBills`. Compact v2 summary: coverage ring
  (`total_covered / total_amount`), Remaining, Covered this period, next
  bill by `due_day` with amount-to-go, and a "Manage bills → /life-map"
  link. Paper disclaimer is rendered on the card.
- `src/routes/_authenticated/life-map.tsx` — dropped the legacy
  Level/Points chip in the header (gamification deferred).
- `src/routes/_authenticated/trade.tsx` — "Life Coverage" balance tile
  now derives from the v2 snapshot instead of `useLifeProgress`.
- Typography: labels use the site standard (`font-mono` uppercase with
  `tracking-[0.18em]` / `[0.2em]`), numeric values use `tabular-nums`,
  matching `/paper`. No custom font-family or letter-spaced typewriter
  styling on body copy anywhere in Life Map surfaces.

## Copy rules

- Never use "Verified Paid" / "paid" / "payment" on Life Map surfaces.
  We say **"Covered"**. The paper disclaimer stays visible.

## Deferred / removed in this pass

- **Life Points gamification.** The legacy card exposed points +
  level from `point_ledger` / `my_points_total`. Not ported to v2 in
  this pass — deferred until the v2-native points model is designed.
- **Per-bill strategy attachment on the home card.** The old CTA
  "Assign N bills → attach each bill to a strategy" is gone.
  Assignment lives on `/life-map` (`assignBillStrategy`); the home
  card just links there with "Manage bills".

## Deleted (orphaned after rewire)

- `src/hooks/useLifeProgress.ts` + test
- `src/components/command/LifeMapExplorer.tsx`
- `src/components/command/LifeMapDashboard.tsx`
- `src/components/command/OnyxLifePlan.tsx`
- `src/components/command/CollectibleTeaserCard.tsx`
- `src/components/command/StrategyLibrary.tsx`
- `src/lib/life-milestones.ts`

## Legacy tables retained (no schema changes this pass)

`life_categories`, `life_obligations`, `life_obligation_history`,
`bill_payment_intents`, `earnings_allocations`, `point_ledger`,
`point_awards`, `milestone_definitions`, and helper modules
`src/lib/life-map-config.ts` / `src/lib/life-history.ts` remain in the
codebase and DB. Nothing on any rendered surface reads them. A future
migration/drop pass will remove them once the retention window closes.

## Legacy data still in the DB (audit at consolidation time)

Snapshot from `public.life_obligations` at consolidation time:

- Active (non-archived) legacy obligations: **10** across **1 user**.
- Active v2 bills: **20**.
- Legacy obligations with **no matching v2 bill** (case-insensitive
  name match, same user, both non-archived): **5**.

We did **not** auto-migrate these rows. If we decide to preserve the 5
without a v2 counterpart, that will be a follow-up copy job — surfaced
here so the decision is explicit, not silent.

## Non-goals of this pass

- No engine / guardian / worker / signer / parity changes.
- `is_live` remains `false`, `SIGN_ORDER` disabled.
- No DB schema changes.
