/**
 * useStrategyEnabled — persisted per-strategy on/off toggle.
 *
 * Reads/writes `public.user_strategy_toggles` for the current user.
 * The row key is `(user_id, strategy)`. There is no local optimistic
 * "success" — the toggle only flips its persisted value after the server
 * confirms the mutation.
 *
 * `strategyKey` is the engine strategy identifier (e.g. "accumulator",
 * "hunter", "sniper"). Cards without an engine leg pass `null`; the hook
 * stays disabled and reports enabled=null.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface ToggleRow {
  user_id: string;
  strategy: string;
  enabled: boolean;
  updated_at: string | null;
}

export interface UseStrategyEnabledResult {
  enabled: boolean | null;
  isLoading: boolean;
  isSaving: boolean;
  error: Error | null;
  updatedAt: string | null;
  setEnabled: (next: boolean) => Promise<void>;
}

export function useStrategyEnabled(
  strategyKey: string | null,
): UseStrategyEnabledResult {
  const { user } = useAuth();
  const qc = useQueryClient();
  const uid = user?.id ?? null;

  const queryKey = ["strategy-toggle", uid, strategyKey] as const;

  const rowQ = useQuery({
    queryKey,
    enabled: !!uid && !!strategyKey,
    queryFn: async (): Promise<ToggleRow | null> => {
      const { data, error } = await supabase
        .from("user_strategy_toggles")
        .select("user_id, strategy, enabled, updated_at")
        .eq("user_id", uid!)
        .eq("strategy", strategyKey!)
        .maybeSingle();
      if (error) throw error;
      return (data as ToggleRow | null) ?? null;
    },
  });

  const enabled: boolean | null = !strategyKey
    ? null
    : rowQ.data
      ? !!rowQ.data.enabled
      : false;

  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      if (!uid || !strategyKey) throw new Error("Not signed in");
      const { error } = await supabase
        .from("user_strategy_toggles")
        .upsert(
          {
            user_id: uid,
            strategy: strategyKey,
            enabled: next,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,strategy" },
        );
      if (error) throw error;
      return next;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey });
    },
  });

  const setEnabled = useCallback(
    async (next: boolean) => {
      await mutation.mutateAsync(next);
    },
    [mutation],
  );

  return {
    enabled,
    isLoading: rowQ.isLoading,
    isSaving: mutation.isPending,
    error: (rowQ.error as Error | null) ?? (mutation.error as Error | null) ?? null,
    updatedAt: rowQ.data?.updated_at ?? null,
    setEnabled,
  };
}
