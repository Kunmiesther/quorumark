// Thin Telegram Bot API client, routed through Lovable's connector gateway —
// NOT called directly against api.telegram.org. TELEGRAM_API_KEY is an
// opaque per-connection key the gateway understands, not necessarily a raw
// BotFather token usable on its own; LOVABLE_API_KEY authenticates this app
// to the gateway itself. Mirrors the pattern already proven working in
// src/routes/api/public/telegram/webhook.ts's sendTelegramMessage.
//
// The webhook secret is likewise derived, not stored: SHA-256 of
// `telegram-webhook:${TELEGRAM_API_KEY}`, base64url-encoded — computed
// identically here and in the webhook route.
//
// AUTHORITY: NONE. This module only sends chat messages / typing indicators.
// It has no import edge to the signer, broker, or any order table.
import { createHash } from "node:crypto";

const GATEWAY_BASE = "https://connector-gateway.lovable.dev/telegram";

function connectionKey(): string {
  const key = process.env.TELEGRAM_API_KEY ?? "";
  if (!key) throw new Error("TELEGRAM_API_KEY not configured — connect Telegram in Lovable");
  return key;
}

/** Matches webhookSecret() in the webhook route exactly — do not diverge. */
export function expectedWebhookSecret(): string {
  return createHash("sha256").update(`telegram-webhook:${connectionKey()}`).digest("base64url");
}

async function call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const lovableKey = process.env.LOVABLE_API_KEY ?? "";
  const telegramKey = connectionKey();
  if (!lovableKey) throw new Error("LOVABLE_API_KEY not configured");

  const res = await fetch(`${GATEWAY_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "Content-Type": "application/json",
      "X-Connection-Api-Key": telegramKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[telegram] ${method} failed [${res.status}]: ${text.slice(0, 200)}`);
    return null;
  }
  try {
    const json = JSON.parse(text) as { ok?: boolean; result?: T };
    return json.result ?? (json as unknown as T);
  } catch {
    return null;
  }
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** MarkdownV2-unsafe by design — callers send plain text or pre-escaped HTML. */
export async function sendMessage(
  chatId: number,
  text: string,
  opts: { buttons?: InlineButton[][] } = {},
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (opts.buttons?.length) body.reply_markup = { inline_keyboard: opts.buttons };
  await call("sendMessage", body);
}

/** `photoUrl` must be a URL Telegram's servers can fetch themselves — no local upload here. */
export async function sendPhoto(
  chatId: number,
  photoUrl: string,
  opts: { caption?: string; buttons?: InlineButton[][] } = {},
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    photo: photoUrl,
    parse_mode: "HTML",
  };
  if (opts.caption) body.caption = opts.caption.slice(0, 1024); // Telegram's own caption limit
  if (opts.buttons?.length) body.reply_markup = { inline_keyboard: opts.buttons };
  await call("sendPhoto", body);
}

export async function sendChatAction(chatId: number, action: "typing" = "typing"): Promise<void> {
  await call("sendChatAction", { chat_id: chatId, action });
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text: text?.slice(0, 200) });
}

let cachedUsername: string | null = null;

/** The bot's @username, fetched once via getMe and cached for the process lifetime. */
export async function getBotUsername(): Promise<string | null> {
  if (cachedUsername) return cachedUsername;
  const result = await call<{ username?: string }>("getMe", {});
  cachedUsername = (result as { username?: string } | null)?.username ?? null;
  return cachedUsername;
}
