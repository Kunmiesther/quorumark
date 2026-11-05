// Rebuild bump: force fresh preview bundle after env-var injection.
import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { waitForPublicBackendEnv } from "@/lib/public-env";

const AUTH_SESSION_RESTORE_TIMEOUT_MS = 8_000;

export async function withAuthRestoreTimeout<T>(
  operation: Promise<T>,
  timeoutMs = AUTH_SESSION_RESTORE_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Stored session restore timed out")), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // isReady flips to true only AFTER supabase.auth.getSession() has resolved
  // from persistent storage. Homepage queries must gate on `isReady && !!user`
  // so we never render with a mid-hydration user snapshot and never leak
  // another session's cached data before the current session is confirmed.
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void waitForPublicBackendEnv().then((env) => {
      if (cancelled) return;
      if (!env.ok) {
        setLoading(false);
        setIsReady(true);
        return;
      }

      // Subscribe FIRST so INITIAL_SESSION is captured.
      const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
        if (cancelled) return;
        setSession(s);
        setUser(s?.user ?? null);
      });
      unsubscribe = () => sub.subscription.unsubscribe();

      // THEN restore from storage. A failed browser storage/network read must
      // never leave the sign-in screen trapped in its loading state.
      void withAuthRestoreTimeout(supabase.auth.getSession())
        .then(({ data }) => {
          if (cancelled) return;
          setSession(data.session);
          setUser(data.session?.user ?? null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          console.warn("[auth] Stored session restore failed", {
            message: error instanceof Error ? error.message : "Unknown auth error",
          });
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
          setIsReady(true);
        });
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return { session, user, loading, isReady };
}
