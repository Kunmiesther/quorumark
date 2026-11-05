/**
 * Admin-only Telegram broadcast — send one message to every linked account.
 *
 * AUTHORITY: NONE beyond sending a chat message. No import edge to the
 * signer, broker, or any order table, same as the rest of src/lib/telegram.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin } from "@/lib/community/access.functions";
import { z } from "zod";

const MAX_RECIPIENTS = 5000;

/** Admin-only: groups/channels registered via /register in the bot, for the broadcast UI's audience picker. */
export const listBroadcastTargets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("telegram_broadcast_targets")
      .select("chat_id, title, chat_type, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`listBroadcastTargets: ${error.message}`);
    return data ?? [];
  });

export const broadcastTelegramAnnouncement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        message: z.string().trim().min(1).max(3500),
        imageUrl: z.string().trim().url().max(2000).optional(),
        sendToIndividuals: z.boolean().default(true),
        groupChatIds: z.array(z.number().int()).max(200).default([]),
        competitionId: z.string().uuid().optional(),
        campaignPhase: z
          .enum(["launch", "reminder", "last_call", "started", "weekly_update", "final_results"])
          .optional(),
      })
      .refine((value) => !value.competitionId || value.campaignPhase, {
        message: "A competition campaign phase is required.",
      })
      .refine((value) => !value.competitionId || !value.sendToIndividuals, {
        message: "Private competition campaigns may only be sent to selected community groups.",
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const competitionAdmin = supabaseAdmin as unknown as { from: (table: string) => any };
    const { sendMessage, sendPhoto } = await import("@/lib/telegram/api.server");

    const chatIds: number[] = [];
    if (data.sendToIndividuals) {
      const { data: accounts, error } = await supabaseAdmin
        .from("telegram_accounts")
        .select("chat_id")
        .limit(MAX_RECIPIENTS);
      if (error) throw new Error(`broadcastTelegramAnnouncement: ${error.message}`);
      for (const r of accounts ?? []) chatIds.push(r.chat_id as number);
    }
    for (const id of data.groupChatIds) chatIds.push(id);

    let competitionCommunityId: string | null = null;
    if (data.competitionId) {
      const { data: competition, error } = await competitionAdmin
        .from("community_competitions")
        .select("community_id")
        .eq("id", data.competitionId)
        .single();
      if (error || !competition) throw new Error("Competition not found.");
      competitionCommunityId = competition.community_id as string;
    }

    let sent = 0;
    let failed = 0;
    for (const chatId of chatIds) {
      try {
        if (data.imageUrl) {
          await sendPhoto(chatId, data.imageUrl, { caption: data.message });
        } else {
          await sendMessage(chatId, data.message);
        }
        sent += 1;
      } catch {
        failed += 1;
      }
    }

    let historyRecorded = true;
    if (data.competitionId && data.campaignPhase && competitionCommunityId) {
      const { error } = await competitionAdmin.from("community_competition_campaigns").insert({
        competition_id: data.competitionId,
        community_id: competitionCommunityId,
        phase: data.campaignPhase,
        message: data.message,
        image_url: data.imageUrl ?? null,
        sent_count: sent,
        failed_count: failed,
        sent_at: new Date().toISOString(),
        created_by: context.userId,
      });
      historyRecorded = !error;
    }

    return { total: chatIds.length, sent, failed, historyRecorded };
  });
