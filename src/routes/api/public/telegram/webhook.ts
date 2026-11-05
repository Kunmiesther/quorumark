/**
 * TELEGRAM WEBHOOK — customer-facing bot entry point.
 *
 * Auth, request validation and outbound sending here match what was proven
 * working against the live Lovable Telegram connector (registered webhook,
 * 401 confirmed on unsigned POSTs): secret is SHA-256 of
 * `telegram-webhook:${TELEGRAM_API_KEY}`, base64url, never stored
 * separately (see expectedWebhookSecret() in src/lib/telegram/api.server.ts);
 * outbound sends go through Lovable's connector gateway, not directly
 * against api.telegram.org.
 *
 * Handles account linking (/start CODE, /link CODE), on-demand ticker
 * analysis (any other text is treated as a symbol and routed through the
 * same three-seat committee used everywhere else in the app), and confirming
 * a paper trade off the most recently analyzed setup for that chat (button
 * tap, or a plain-language "yes"/"go ahead"/"make the trade").
 *
 * AUTHORITY: paper-only, and only via the mandatory AI-orchestration gate.
 * `evaluateTicker` is pure advisory (see src/lib/ai/committee/schema.ts);
 * trade confirmation goes through `placeManualPaperTrade`, which re-runs the
 * SAME committee+ONYX+risk orchestration the automated engine uses before
 * any paper_positions row can be written — there is no shortcut path, and no
 * import edge to the signer, broker, or a live venue anywhere in this file's
 * call graph.
 */
import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const telegramFromSchema = z.object({
  id: z.number().int(),
  username: z.string().optional(),
  first_name: z.string().optional(),
});

const telegramMessageSchema = z.object({
  chat: z.object({
    id: z.number().int(),
    type: z.string().optional(),
    title: z.string().optional(),
  }),
  text: z.string().trim().max(4096).optional(),
  from: telegramFromSchema.optional(),
});

const telegramCallbackQuerySchema = z.object({
  id: z.string(),
  data: z.string().max(64).optional(),
  message: z.object({ chat: z.object({ id: z.number().int() }) }).optional(),
});

const telegramUpdateSchema = z
  .object({
    update_id: z.number().int().nonnegative(),
    message: telegramMessageSchema.optional(),
    edited_message: telegramMessageSchema.optional(),
    callback_query: telegramCallbackQuerySchema.optional(),
  })
  .strict();

const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;

function secretsMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const VERDICT_LABEL: Record<string, string> = {
  shadow_endorse: "ENDORSE",
  shadow_weak_endorse: "WEAK ENDORSE",
  shadow_reject: "REJECT",
  shadow_no_consensus: "NO CONSENSUS",
  shadow_unavailable: "UNAVAILABLE",
};

const REJECT_REASON_LABEL: Record<string, string> = {
  onyx_reject: "the council's synthesis (ONYX) did not confirm this setup",
  onyx_wait: "the council's synthesis (ONYX) said wait, not enter",
  unsupported_authority_mode: "your account uses an execution mode this command doesn't support yet",
  wallet_occupied: "you already have an open paper position on this symbol/direction",
  wallet_disabled: "that paper wallet is disabled",
  insufficient_wallet_balance: "insufficient paper wallet balance",
  size_rounds_to_zero: "position size rounded to zero at this price",
};

const PENDING_TRADE_TTL_MS = 5 * 60_000; // one 5m candle
const CONFIRM_PHRASES = ["yes", "confirm", "go ahead", "make the trade", "place it", "place the trade", "do it", "trade it", "execute"];
const CANCEL_PHRASES = ["no", "cancel", "skip", "never mind", "nevermind"];

// Loose intent match, not an exact-phrase list — "what is the best setup you
// see", "any good trades right now", "top pick?" should all work, not just
// the handful of exact strings someone happened to type first. Gated on
// containing a space so a genuine one-word ticker (e.g. a coin literally
// called SCAN) can never be swallowed by this.
const SCAN_INTENT_PATTERNS = [
  /\bscan\b/,
  /\b(best|top|good|any)\b.*\b(setup|trade|pick|opportunit)/,
  /\bwhat.*\b(you )?(see|got|find)\b/,
  /\bfind (me )?a trade\b/,
  /\bwhat'?s good\b/,
];
function isScanIntent(textLower: string): boolean {
  if (textLower === "/scan") return true;
  if (!textLower.includes(" ")) return false;
  return SCAN_INTENT_PATTERNS.some((re) => re.test(textLower));
}

function fmtPrice(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 1 : n >= 1 ? 4 : 8 });
}

/** Truncate at a word boundary with an ellipsis, never mid-word — a hard slice() reads as a broken/garbled message. */
function truncateSummary(text: string, maxLen = 280): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

async function handleLink(
  admin: import("@supabase/supabase-js").SupabaseClient,
  chatId: number,
  from: { username?: string; first_name?: string } | undefined,
  code: string,
) {
  const { sendMessage } = await import("@/lib/telegram/api.server");
  const clean = code.trim().toUpperCase();
  if (!clean) {
    await sendMessage(chatId, "Send your link code as: <code>/link ABC1234</code>");
    return;
  }
  const { data: row } = await admin
    .from("telegram_link_codes")
    .select("user_id, expires_at")
    .eq("code", clean)
    .maybeSingle();

  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    await sendMessage(chatId, "That code is invalid or expired. Generate a new one from your TurtleBot profile → Telegram.");
    return;
  }

  await admin.from("telegram_accounts").upsert(
    {
      chat_id: chatId,
      user_id: row.user_id,
      telegram_username: from?.username ?? null,
      telegram_first_name: from?.first_name ?? null,
      linked_at: new Date().toISOString(),
    },
    { onConflict: "chat_id" },
  );
  await admin.from("telegram_link_codes").delete().eq("code", clean);

  await sendMessage(
    chatId,
    "✅ Linked. Send any ticker (e.g. <code>BTC</code> or <code>ETH-USDT</code>) and the council will look at it.",
  );
}

/**
 * Registers the current group/supergroup as a broadcast target — separate
 * from individual telegram_accounts DMs. Restricted to senders whose personal
 * chat is already linked to an admin account, so a random group member (or a
 * stranger who adds the bot somewhere) can't opt a chat into announcements.
 */
async function handleRegisterGroup(
  admin: import("@supabase/supabase-js").SupabaseClient,
  chatId: number,
  chatType: string | undefined,
  chatTitle: string | undefined,
  fromId: number | undefined,
) {
  const { sendMessage } = await import("@/lib/telegram/api.server");

  if (chatType !== "group" && chatType !== "supergroup") {
    await sendMessage(chatId, "/register only works inside a group — add me to your community group and run it there.");
    return;
  }
  if (!fromId) {
    await sendMessage(chatId, "Couldn't identify who sent that — try again.");
    return;
  }

  const { data: senderAccount } = await admin
    .from("telegram_accounts")
    .select("user_id")
    .eq("chat_id", fromId)
    .maybeSingle();
  if (!senderAccount) {
    await sendMessage(chatId, "Only a linked admin account can register this group. Link your personal chat first (/link CODE from your TurtleBot profile).");
    return;
  }

  const { isAdminUser } = await import("@/lib/community/access.functions");
  const admin_ = await isAdminUser(admin, senderAccount.user_id as string);
  if (!admin_) {
    await sendMessage(chatId, "Only a TurtleBot admin can register this group for announcements.");
    return;
  }

  await admin.from("telegram_broadcast_targets").upsert(
    {
      chat_id: chatId,
      title: chatTitle ?? null,
      chat_type: chatType,
      registered_by: senderAccount.user_id as string,
    },
    { onConflict: "chat_id" },
  );

  await sendMessage(chatId, `✅ This group is now registered for TurtleBot announcements${chatTitle ? ` (${chatTitle})` : ""}.`);
}

async function handleTicker(
  admin: import("@supabase/supabase-js").SupabaseClient,
  chatId: number,
  userId: string,
  rawSymbol: string,
) {
  const { sendMessage, sendChatAction } = await import("@/lib/telegram/api.server");
  const { evaluateTicker } = await import("@/lib/telegram/ticker.server");
  const { roleName } = await import("@/lib/ai/committee/roles");
  const { MANUAL_TRADE_DEFAULTS } = await import("@/lib/paper/manualTrade.server");

  await sendChatAction(chatId, "typing");
  const result = await evaluateTicker(admin, userId, rawSymbol);

  if (!result.ok) {
    const messages: Record<string, string> = {
      invalid_symbol: "That doesn't look like a ticker. Try something like <code>BTC</code>.",
      unknown_symbol: `Don't recognize <b>${rawSymbol.toUpperCase()}</b> on ApeX Omni.`,
      feed_unavailable: "Couldn't reach the market data feed just now — try again shortly.",
      no_clear_setup: `No clear directional setup on <b>${"symbol" in result ? result.symbol : rawSymbol}</b> right now (flat/choppy tape).`,
      entry_geometry_rejected: `No valid entry geometry on <b>${"symbol" in result ? result.symbol : rawSymbol}</b> right now.`,
      evaluation_failed: "The council couldn't be reached — try again shortly.",
    };
    await sendMessage(chatId, messages[result.reason] ?? "Something went wrong.");
    return;
  }

  const { symbol, direction, plan, evaluation, trendState, candleCloseMs, tickSize, stepSize, maxLeverage } = result;
  const lines: string[] = [];
  lines.push(`📊 <b>${symbol}</b> — <b>${direction.toUpperCase()}</b> setup (5m)`);
  lines.push(
    `Entry: ${fmtPrice(plan.entry)} · Stop: ${fmtPrice(plan.stop)} · TP: ${plan.tpLevels.map(fmtPrice).join(", ")}`,
  );
  lines.push("");
  const verdict = VERDICT_LABEL[evaluation.verdict] ?? evaluation.verdict;
  const conf = evaluation.consensusConfidence != null ? ` (${Math.round(evaluation.consensusConfidence * 100)}%)` : "";
  lines.push(`<b>Council verdict:</b> ${verdict}${conf}`);
  for (const o of evaluation.outcomes) {
    if (o.available) {
      lines.push(
        `• ${roleName(o.role)}: ${o.response.direction} · ${Math.round(o.response.confidence * 100)}% — ${truncateSummary(o.response.summary)}`,
      );
    } else {
      lines.push(`• ${roleName(o.role)}: unavailable (${o.reason})`);
    }
  }
  if (evaluation.riskFlags.length) {
    lines.push("");
    lines.push(`⚠️ Risk flags: ${evaluation.riskFlags.join(", ")}`);
  }
  lines.push("");
  lines.push(
    `Reply <b>yes</b> or tap below to open a $${MANUAL_TRADE_DEFAULTS.marginUsd} paper position at ${MANUAL_TRADE_DEFAULTS.leverage}× — paper only, real committee review, expires in 5 minutes.`,
  );

  await admin.from("telegram_pending_trades").upsert(
    {
      chat_id: chatId,
      user_id: userId,
      symbol,
      direction,
      entry_price: plan.entry,
      stop_level: plan.stop,
      tp_levels: plan.tpLevels,
      candle_close_ms: candleCloseMs,
      tick_size: tickSize,
      step_size: stepSize,
      max_leverage: maxLeverage,
      trend_state: trendState,
      expires_at: new Date(Date.now() + PENDING_TRADE_TTL_MS).toISOString(),
    },
    { onConflict: "chat_id" },
  );

  await sendMessage(chatId, lines.join("\n"), {
    buttons: [[{ text: `✅ Place $${MANUAL_TRADE_DEFAULTS.marginUsd} paper trade`, callback_data: "confirm_trade" }]],
  });
}

async function handleConfirmTrade(
  admin: import("@supabase/supabase-js").SupabaseClient,
  chatId: number,
  userId: string,
) {
  const { sendMessage, sendChatAction } = await import("@/lib/telegram/api.server");
  await sendChatAction(chatId, "typing");

  const { data: pending } = await admin
    .from("telegram_pending_trades")
    .select("*")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (!pending || new Date(pending.expires_at).getTime() < Date.now()) {
    await sendMessage(chatId, "That setup has expired — send the ticker again to get a fresh read.");
    return;
  }
  if (pending.user_id !== userId) {
    await sendMessage(chatId, "That setup isn't for your linked account.");
    return;
  }

  const { placeManualPaperTrade } = await import("@/lib/paper/manualTrade.server");
  const result = await placeManualPaperTrade(admin, userId, {
    symbol: pending.symbol,
    direction: pending.direction as "long" | "short",
    entryPrice: Number(pending.entry_price),
    stopLevel: pending.stop_level == null ? null : Number(pending.stop_level),
    tpLevels: (pending.tp_levels as number[]) ?? [],
    candleCloseMs: Number(pending.candle_close_ms),
    tickSize: pending.tick_size == null ? null : Number(pending.tick_size),
    stepSize: pending.step_size == null ? null : Number(pending.step_size),
    maxLeverage: pending.max_leverage == null ? null : Number(pending.max_leverage),
    trendState: pending.trend_state,
    strategy: "telegram_manual",
  });

  await admin.from("telegram_pending_trades").delete().eq("chat_id", chatId);

  if (!result.ok) {
    const detail = REJECT_REASON_LABEL[result.reason] ?? result.reason;
    await sendMessage(chatId, `❌ Trade not placed — ${detail}.`);
    return;
  }

  await sendMessage(
    chatId,
    `✅ Paper position opened: <b>${pending.symbol}</b> ${pending.direction.toUpperCase()} · ` +
      `${result.qty.toFixed(6)} units · $${result.marginUsd} margin · ${result.leverage}× leverage.`,
  );
}

async function handleReallocCallback(
  admin: import("@supabase/supabase-js").SupabaseClient,
  chatId: number,
  userId: string,
  action: "apply" | "dismiss",
  suggestionId: string,
) {
  const { sendMessage } = await import("@/lib/telegram/api.server");
  const { applyReallocation, dismissReallocation } = await import("@/lib/bills/reallocation.functions");

  if (action === "dismiss") {
    await dismissReallocation(admin, userId, suggestionId);
    await sendMessage(chatId, "Skipped.");
    return;
  }

  const result = await applyReallocation(admin, userId, suggestionId);
  if (!result.ok) {
    await sendMessage(chatId, "That surplus is no longer available — someone may have already applied it.");
    return;
  }
  await sendMessage(
    chatId,
    `✅ Applied — $${result.surplus_usd.toFixed(2)} moved to ${result.targets.length} bill${result.targets.length === 1 ? "" : "s"}. Check /life-map in the app for the update.`,
  );
}

/** Best-effort: piggyback surplus detection on any linked-user interaction, so a Telegram-only user still gets notified without needing an external cron. */
async function checkReallocationSuggestions(
  admin: import("@supabase/supabase-js").SupabaseClient,
  userId: string,
) {
  try {
    const { detectReallocationSuggestions } = await import("@/lib/bills/reallocation.functions");
    await detectReallocationSuggestions(admin, userId);
  } catch (e) {
    console.error("[telegram-webhook:realloc-check]", e instanceof Error ? e.message : e);
  }
}

async function handleScan(
  admin: import("@supabase/supabase-js").SupabaseClient,
  chatId: number,
  userId: string,
) {
  const { sendMessage, sendChatAction } = await import("@/lib/telegram/api.server");
  await sendChatAction(chatId, "typing");
  await sendMessage(chatId, "🔍 Scanning the market — checking liquid symbols against the council, this can take a minute…");

  const { runCommitteeCycle } = await import("@/lib/ai/committee/cycle.server");
  await runCommitteeCycle(admin, userId, { book: "paper" });

  // Idempotent per candle: if this candle was already scanned (by cron or a
  // prior /scan this minute), this reads back that result instead of
  // re-spending model budget — same guarantee runCommitteeCycle gives itself.
  const { data: cycle } = await admin
    .from("committee_cycles")
    .select("status, universe_size, candidate_count, reviewed_count, selected_symbol, selected_direction, no_trade_reason")
    .eq("user_id", userId)
    .eq("book", "paper")
    .order("candle_close_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!cycle || cycle.status !== "selected" || !cycle.selected_symbol) {
    const scanned = cycle?.universe_size ?? 0;
    const candidates = cycle?.candidate_count ?? 0;
    const reason = cycle?.no_trade_reason ?? "no scan result available";
    await sendMessage(
      chatId,
      `No trade-worthy setup right now. Scanned ${scanned} symbols, ${candidates} cleared prefiltering — none passed the council. Reason: ${reason}.`,
    );
    return;
  }

  await sendMessage(
    chatId,
    `Best setup found: <b>${cycle.selected_symbol}</b> ${(cycle.selected_direction ?? "").toUpperCase()} — pulling the full read…`,
  );
  await handleTicker(admin, chatId, userId, cycle.selected_symbol);
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
        let expected = "";
        try {
          const { expectedWebhookSecret } = await import("@/lib/telegram/api.server");
          expected = expectedWebhookSecret();
        } catch {
          // TELEGRAM_API_KEY not configured — fail closed below.
        }
        if (!expected || !secretsMatch(provided, expected)) {
          return new Response(JSON.stringify({ ok: false }), { status: 401, headers: RESPONSE_HEADERS });
        }

        const contentLength = Number(request.headers.get("content-length") ?? "0");
        if (contentLength > 65_536) {
          return new Response(JSON.stringify({ ok: false }), { status: 413, headers: RESPONSE_HEADERS });
        }

        let input: unknown;
        try {
          input = await request.json();
        } catch {
          return new Response(JSON.stringify({ ok: false }), { status: 400, headers: RESPONSE_HEADERS });
        }

        const parsed = telegramUpdateSchema.safeParse(input);
        if (!parsed.success) {
          return new Response(JSON.stringify({ ok: false }), { status: 400, headers: RESPONSE_HEADERS });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // ---- Inline-button confirm (callback_query) ----
        const cb = parsed.data.callback_query;
        if (cb) {
          const { answerCallbackQuery } = await import("@/lib/telegram/api.server");
          const cbChatId = cb.message?.chat.id;
          try {
            if (cbChatId) {
              const { data: account } = await supabaseAdmin
                .from("telegram_accounts")
                .select("user_id")
                .eq("chat_id", cbChatId)
                .maybeSingle();
              if (account) {
                const userId = account.user_id as string;
                if (cb.data === "confirm_trade") {
                  await handleConfirmTrade(supabaseAdmin, cbChatId, userId);
                } else if (cb.data?.startsWith("apply_realloc:")) {
                  await handleReallocCallback(supabaseAdmin, cbChatId, userId, "apply", cb.data.slice(14));
                } else if (cb.data?.startsWith("dismiss_realloc:")) {
                  await handleReallocCallback(supabaseAdmin, cbChatId, userId, "dismiss", cb.data.slice(16));
                }
              }
            }
          } catch (e) {
            console.error("[telegram-webhook:callback]", e instanceof Error ? e.message : e);
          }
          await answerCallbackQuery(cb.id).catch(() => {});
          return new Response(JSON.stringify({ ok: true }), { headers: RESPONSE_HEADERS });
        }

        const message = parsed.data.message ?? parsed.data.edited_message;
        if (!message?.text) {
          return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: RESPONSE_HEADERS });
        }

        const chatId = message.chat.id;
        const text = message.text.trim();
        const textLower = text.toLowerCase();
        // Diagnostic: which branch a message takes, plus the exact codepoints we
        // matched against (smart quotes / NBSP / trailing junk show up here).
        console.log(
          `[telegram-webhook:route] scanIntent=${isScanIntent(textLower)} raw=${JSON.stringify(message.text)}`,
        );
        const { sendMessage } = await import("@/lib/telegram/api.server");


        try {
          if (text === "/start" || text.startsWith("/start ")) {
            const payload = text.slice(6).trim();
            if (payload) {
              await handleLink(supabaseAdmin, chatId, message.from, payload);
            } else {
              await sendMessage(
                chatId,
                "👋 Welcome to TurtleBot. Link your account from your profile's Telegram page, then send me the code with <code>/link CODE</code>.",
              );
            }
          } else if (text.startsWith("/link")) {
            await handleLink(supabaseAdmin, chatId, message.from, text.slice(5).trim());
          } else if (text === "/register") {
            await handleRegisterGroup(supabaseAdmin, chatId, message.chat.type, message.chat.title, message.from?.id);
          } else if (text === "/help") {
            await sendMessage(
              chatId,
              "Send any ticker (e.g. <code>BTC</code>) to get the council's read, or send <code>/scan</code> (or \"best setup\") to have it scan the market for you. " +
                "Reply <b>yes</b> to open a paper trade on whatever it found. Use /link CODE to connect your account first. " +
                "Admins: run <code>/register</code> inside a group to add it as a broadcast target for announcements.",
            );
          } else {
            const { data: account } = await supabaseAdmin
              .from("telegram_accounts")
              .select("user_id")
              .eq("chat_id", chatId)
              .maybeSingle();
            // Best-effort piggyback: any linked-user message is a chance to
            // catch a new surplus and notify them, without needing an
            // external cron for the Telegram-only case.
            if (account) await checkReallocationSuggestions(supabaseAdmin, account.user_id as string);
            if (!account) {
              await sendMessage(
                chatId,
                "You're not linked yet. Open your TurtleBot profile → Telegram to get a code, then send <code>/link CODE</code>.",
              );
            } else if (CONFIRM_PHRASES.includes(textLower)) {
              const { data: pending } = await supabaseAdmin
                .from("telegram_pending_trades")
                .select("chat_id")
                .eq("chat_id", chatId)
                .maybeSingle();
              if (pending) {
                await handleConfirmTrade(supabaseAdmin, chatId, account.user_id as string);
              } else {
                await sendMessage(chatId, "Nothing to confirm yet — send a ticker first (e.g. <code>BTC</code>).");
              }
            } else if (CANCEL_PHRASES.includes(textLower)) {
              await supabaseAdmin.from("telegram_pending_trades").delete().eq("chat_id", chatId);
              await sendMessage(chatId, "Cancelled.");
            } else if (isScanIntent(textLower)) {
              await handleScan(supabaseAdmin, chatId, account.user_id as string);
            } else if (text.startsWith("/")) {
              await sendMessage(chatId, "Unknown command. Send a ticker like <code>BTC</code> to get the council's read.");
            } else {
              await handleTicker(supabaseAdmin, chatId, account.user_id as string, text);
            }
          }
        } catch (e) {
          console.error("[telegram-webhook]", e instanceof Error ? e.message : e);
          await sendMessage(chatId, "Something went wrong on our end — try again shortly.").catch(() => {});
        }

        return new Response(JSON.stringify({ ok: true }), { headers: RESPONSE_HEADERS });
      },
    },
  },
});
