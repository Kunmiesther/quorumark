# Telegram bot — setup

The bot lives inside the main web app, deployed with Lovable Cloud — not
Railway. It never imports the signer, broker, or execution-broker.

- Route: `src/routes/api/public/telegram/webhook.ts` →
  `POST /api/public/telegram/webhook`
- Outbound calls (send message, getMe, etc.) go through Lovable's connector
  gateway (`https://connector-gateway.lovable.dev/telegram/<method>`), never
  directly against `api.telegram.org` — see `src/lib/telegram/api.server.ts`.

## Credentials — via the Lovable Telegram connector, not manual secrets

Connect Telegram in Lovable Cloud's connector settings. That provisions
`TELEGRAM_API_KEY` (an opaque per-connection key the gateway understands —
not necessarily a raw BotFather token usable on its own). `LOVABLE_API_KEY`
authenticates this app to the gateway itself; it's already configured (the
AI committee's model calls use the same variable).

Nothing else is stored separately:

- **Webhook secret** — `base64url(SHA-256("telegram-webhook:" + TELEGRAM_API_KEY))`,
  computed identically wherever it's needed (`expectedWebhookSecret()` in
  `api.server.ts`).
- **Bot username** — fetched via `getMe` through the gateway and cached
  (`getBotUsername()`), not a config value.

## Webhook registration

The Telegram connector has no "Webhook URL" field in the Lovable UI — the
webhook is registered directly with Telegram's Bot API (`setWebhook`), a
one-time step outside Lovable, repeated only when the domain changes.

Currently registered (production):
`https://turtlebot.app/api/public/telegram/webhook`

Note: `https://turtle-trade-guard.lovable.app/...` 307-redirects to the
custom domain and Telegram does not follow redirects — always register the
custom domain (`turtlebot.app`) while it is attached.

## Test end to end

1. Open the app → Profile → Telegram → "Generate link code".
2. Tap "Open Telegram & link" (or message the bot manually and send
   `/link <code>`).
3. Send a ticker, e.g. `BTC`. The bot should reply with the same three-seat
   committee read (Lead Strategist / Risk Guardian / Market Structure
   Analyst) used elsewhere in the app, plus a "Place paper trade" button.
4. Reply `yes` (or tap the button) within 5 minutes to open a paper
   position. This re-runs the mandatory AI orchestration gate
   (`orchestratePaperCandidate` — committee + ONYX synthesis + one
   consolidated risk check) before anything is written to `paper_positions`;
   there is no shortcut around it, so a rejection (ONYX says wait/reject,
   risk check fails, wallet occupied, etc.) is expected and normal, not a bug.

## Current scope (v1)

- Account linking, on-demand ticker analysis, and paper trade confirmation
  (fixed $50 margin / 5× leverage, single entry, no ladder/DCA) are live —
  see `src/lib/paper/manualTrade.server.ts`.
- This was also the first "atomic submit" path built anywhere in the app —
  the web dashboard's own manual ticket (`TradeDesk.tsx`) is still a
  preview-only stub. Wiring the dashboard's Deploy button to call the same
  function is a natural fast-follow, not a separate implementation.
- Live (real-money) trading is still completely out of scope here and stays
  structurally disabled per `docs/AUTHORITY_MATRIX.md`.
- SMS/WhatsApp (Twilio) will reuse the same `evaluateTicker` /
  `placeManualPaperTrade` core once you have a Twilio account — no need to
  duplicate the committee or execution logic per channel.

## Schema-drift note

`telegram_link_codes`, `telegram_accounts`, and `telegram_pending_trades`
were applied directly against the live database (via a SQL client) rather
than through Lovable's own migration flow, because a normal publish did not
pick up the migration files in `supabase/migrations/`. As of this writing
`src/integrations/supabase/types.ts` on `main` has been regenerated at least
once since and does NOT include these three tables — they had to be
re-added by hand here. If a future Lovable-driven schema sync drops them
again, that's the same drift, not a new bug: the tables exist and work in
the live database; Lovable's own schema tracking just doesn't know about
them yet.
