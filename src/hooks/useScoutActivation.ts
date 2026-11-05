/**
 * useScoutActivation — server-backed on/off preference for Scout intelligence.
 *
 * Historical localStorage key `turtlebot.scout.active` is still consulted for
 * a best-effort one-time migration when the server row is missing. After a
 * successful server write the local key is removed.
 *
 * The exported shape (`{ active, setActive, toggle }`) is compatible with
 * the previous localStorage-only implementation so existing consumers (Home
 * CommandAvatars, ScoutFab, etc.) do not need changes.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getScoutPreference, setScoutPreference } from "@/lib/scout/preferences.functions";
import { useAuth } from "@/hooks/useAuth";

const LEGACY_KEY = "turtlebot.scout.active";

export function useScoutActivation() {
  const { isReady, user } = useAuth();
  const qc = useQueryClient();
  const getPref = useServerFn(getScoutPreference);
  const setPref = useServerFn(setScoutPreference);

  const enabled = isReady && !!user;

  const query = useQuery({
    queryKey: ["scout", "preference", user?.id ?? "anon"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const pref = await getPref();
      return pref;
    },
  });

  const mutate = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await setPref({ data: { active: next } });
      try {
        if (res.persistent) window.localStorage.removeItem(LEGACY_KEY);
        else window.localStorage.setItem(LEGACY_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return res;
    },
    onMutate: async (next) => {
      const key = ["scout", "preference", user?.id ?? "anon"] as const;
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData(key);
      qc.setQueryData(key, {
        active: next,
        updatedAt: new Date().toISOString(),
        persistent: query.data?.persistent ?? false,
      });
      return { key, previous };
    },
    onError: (_error, _next, context) => {
      if (context) qc.setQueryData(context.key, context.previous);
    },
    onSuccess: (data) => {
      qc.setQueryData(["scout", "preference", user?.id ?? "anon"], data);
    },
  });

  // Best-effort one-time migration for older deployments whose server
  // default was off. Explicit persisted preferences still win. Silent-fail
  // on localStorage errors (private mode etc.).
  useEffect(() => {
    if (!enabled) return;
    if (query.data?.persistent && query.data?.updatedAt) return; // server row already exists
    try {
      const legacy = window.localStorage.getItem(LEGACY_KEY);
      if (!query.data?.persistent && (legacy === "1" || legacy === "0")) {
        qc.setQueryData(["scout", "preference", user?.id ?? "anon"], {
          active: legacy === "1",
          updatedAt: query.data?.updatedAt ?? null,
          persistent: false,
        });
      } else if (!query.data?.active && legacy === "1") {
        mutate.mutate(true);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, query.data?.active, query.data?.updatedAt, query.data?.persistent, qc, user?.id]);

  const active = !!query.data?.active;

  const setActive = useCallback(
    (next: boolean) => {
      mutate.mutate(next);
    },
    [mutate],
  );

  const toggle = useCallback(() => setActive(!active), [active, setActive]);

  return useMemo(
    () => ({
      active,
      setActive,
      toggle,
      loading: !isReady || query.isLoading,
      saving: mutate.isPending,
      error:
        (mutate.error instanceof Error ? mutate.error.message : null) ??
        (query.error instanceof Error ? query.error.message : null),
      persistent: query.data?.persistent ?? true,
      /** No signed-in user — the switch is inert until they authenticate. */
      unauthenticated: isReady && !user,
    }),
    [
      active,
      setActive,
      toggle,
      isReady,
      query.isLoading,
      query.error,
      query.data?.persistent,
      mutate.isPending,
      mutate.error,
      user,
    ],
  );
}
