/**
 * Scout preference — persistent per-user on/off switch.
 *
 * READ-ONLY intelligence contract. This module does not import from the
 * paper engine, Onyx execution, execution broker, signer, or wallets.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export interface ScoutPreference {
  active: boolean;
  updatedAt: string | null;
  /** False only on older deployments that do not have the preference table. */
  persistent: boolean;
}

function missingScoutRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /scout_preferences|schema cache|does not exist/i.test(error.message ?? "")
  );
}

export const getScoutPreference = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ScoutPreference> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("scout_preferences")
      .select("active, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (missingScoutRelation(error)) {
      return { active: true, updatedAt: null, persistent: false };
    }
    if (error) throw new Error(`scout pref read failed: ${error.message}`);
    // No row means the internal-test default (active). Once a user writes a
    // preference, that explicit value remains authoritative.
    if (!data) return { active: true, updatedAt: null, persistent: true };
    return { active: !!data.active, updatedAt: data.updated_at ?? null, persistent: true };
  });

const SetInput = z.object({ active: z.boolean() });

export const setScoutPreference = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => SetInput.parse(raw))
  .handler(async ({ context, data }): Promise<ScoutPreference> => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("scout_preferences")
      .upsert(
        { user_id: userId, active: data.active, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      )
      .select("active, updated_at")
      .single();
    if (missingScoutRelation(error)) {
      return { active: data.active, updatedAt: new Date().toISOString(), persistent: false };
    }
    if (error) throw new Error(`scout pref write failed: ${error.message}`);
    return { active: !!row.active, updatedAt: row.updated_at ?? null, persistent: true };
  });
