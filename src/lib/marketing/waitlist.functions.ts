import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const WAITLIST_KINDS = [
  "presale",
  "nft_genesis",
  "nft_evolution",
  "merch",
  "community",
  "general",
] as const;

const inputSchema = z.object({
  kind: z.enum(WAITLIST_KINDS),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(320),
  source: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  consent: z.literal(true, {
    errorMap: () => ({ message: "You must accept the notice to join the waitlist." }),
  }),
});

export type WaitlistInput = z.infer<typeof inputSchema>;

/**
 * Public server function that accepts a waitlist entry. Writes go via the
 * service-role admin client so we don't need to expose broader anon writes.
 * The client passes user_agent from the browser; we clip it before storing.
 */
export const submitWaitlistEntry = createServerFn({ method: "POST" })
  .inputValidator((raw) => {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0]?.message ?? "Invalid submission";
      throw new Error(first);
    }
    return parsed.data;
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("waitlist_signups").insert({
      kind: data.kind,
      email: data.email,
      source: data.source ?? null,
      notes: data.notes ?? null,
      consent: data.consent,
    });
    if (error) {
      // Duplicate: succeed silently so the UI stays friendly.
      if (error.code === "23505") return { ok: true, duplicate: true };
      console.error("[waitlist] insert failed", error);
      throw new Error("Could not submit right now. Please try again shortly.");
    }
    return { ok: true, duplicate: false };
  });
