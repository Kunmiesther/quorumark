# Database cleanup — 2026-10-16

## Authorized scope

Remove proven disposable data without resetting accounts or altering trading
history, settings, strategies, wallet permissions, positions, or P&L.

## Findings

The database measured 698,444,947 bytes (approximately 666 MiB). Its largest
tables were `bot_events` (145 MiB), `ai_usage_events` (98 MiB),
`paper_live_shadow_ledger` (55 MiB), `onyx_decisions` (52 MiB), and `ops_events`
(51 MiB). They contain operational, AI-cost, comparison, and decision evidence;
size alone does not make them dead data. They were not deleted. Most of these
tables had zero estimated dead tuples and recent automatic maintenance.

`paper_tick_leases` is a per-user, per-minute duplicate-processing guard, not
a trade ledger. The repository's original migration specifies one-day
retention. Current callers claim the current minute, not historical buckets.
There were 24,213 leases older than one day, starting September 15. No incoming
foreign keys or custom triggers depend on those rows. The deployed database
has neither the expected cleanup function nor `cron.job`; do not replay the
whole historical migration, which also contains unrelated scheduler changes.

## Cleanup performed

- Backed up and validated **23,397 rows**, including their composite keys and
  original fields, in a private local JSON file outside the repository.
- Deleted exactly those expired coordination rows with **both** `claimed_at`
  and `minute_bucket` before **2026-10-15 00:00:00 UTC**. This keeps more than
  the documented 24-hour retention window.
- Verification found zero rows remaining before that cutoff and 1,968 recent
  leases retained. The database still contained 74 live-position rows, 306
  paper-position rows, and 177 trade records; the cleanup statement could
  only modify `paper_tick_leases`.
- No table, index, function, policy, trade, fill, P&L record, session,
  configuration, or position was deleted or reset.
- No `VACUUM FULL`, blocking table rewrite, or schema migration was performed.
  Row deletion does not promise an immediate reduction in physical disk size;
  normal vacuum can make that space reusable.

The local backup is at
`/Users/BiancaSwilley/Documents/Codex/2026-09-02/ar/.turtlebot-verification.uBOhIr/expired-paper-leases-backup.json`.
It contains account IDs and must not be committed. Recovery is possible from
that backup, although obsolete processing leases should normally stay expired.

## Retained / follow-up

- Preserve exchange recovery, uncertain order intents, fills, settlement
  evidence, AI decisions and missed-opportunity records. They are needed to
  explain trading and investigate current blockers.
- A recurring bounded lease-retention mechanism still needs a separately
  tested deployment; this one-time cleanup does not create a scheduler.
- Larger savings require an explicit archive/retention policy for operational
  and AI-usage history, plus dependency and restore checks before deletion.
  Empty tables or zero index scans alone are not grounds for dropping them.
