// Dashboard-side of Telegram account linking. The code minted here is
// redeemed by the webhook (src/routes/api/public/telegram/webhook.ts)
// using the service-role client — this file never touches chat_id.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const LINK_CODE_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

async function randomCode(length = 7): Promise<string> {
  const bytes = new Uint8Array(length);
  const webCrypto = (globalThis.crypto as Crypto | undefined);
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    const nodeCrypto = await import("node:crypto");
    nodeCrypto.randomFillSync(bytes);
  }
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export interface TelegramLinkCode {
  code: string;
  expiresAt: string;
  botUsername: string | null;
}

/** Mint a fresh single-use code, replacing any still-live code for this user. */
export const createTelegramLinkCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TelegramLinkCode> => {
    const { supabase, userId } = context;
    await supabase.from("telegram_link_codes").delete().eq("user_id", userId);

    const code = await randomCode();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
    const { error } = await supabase
      .from("telegram_link_codes")
      .insert({ code, user_id: userId, expires_at: expiresAt });
    if (error) throw new Error("Could not create a link code");

    const { getBotUsername } = await import("./api.server");
    const botUsername = await getBotUsername().catch(() => null);

    return { code, expiresAt, botUsername };
  });

export interface TelegramLinkStatus {
  linked: boolean;
  telegramUsername: string | null;
  linkedAt: string | null;
}

export const getTelegramLinkStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TelegramLinkStatus> => {
    const { data } = await context.supabase
      .from("telegram_accounts")
      .select("telegram_username, linked_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!data) return { linked: false, telegramUsername: null, linkedAt: null };
    return { linked: true, telegramUsername: data.telegram_username, linkedAt: data.linked_at };
  });

export const unlinkTelegram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ok: true }> => {
    await context.supabase.from("telegram_accounts").delete().eq("user_id", context.userId);
    return { ok: true };
  });
