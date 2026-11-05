import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import {
  getMissingPublicBackendEnv,
  getPublicBackendEnvMessage,
  reportPublicBackendEnvMissingOnce,
  type PublicEnvName,
} from "@/lib/public-env";

type EnvCheckState =
  | { status: "pending"; missing: PublicEnvName[] }
  | { status: "ready"; missing: [] }
  | { status: "missing"; missing: PublicEnvName[] };

const RETRY_DELAYS_MS = [0, 250, 750, 1_500];

export function BackendConfigGuard({ children }: { children: ReactNode }) {
  // Start pending on both SSR and the first client render. The mounted retry
  // loop decides whether config is truly missing, avoiding hydration-time
  // false negatives from turning into a crash or mismatch.
  const [state, setState] = useState<EnvCheckState>({ status: "pending", missing: [] });
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];

    const runCheck = (finalAttempt: boolean) => {
      const missing = getMissingPublicBackendEnv();
      if (cancelled) return;

      if (missing.length === 0) {
        setState({ status: "ready", missing: [] });
        return;
      }

      if (finalAttempt) {
        reportPublicBackendEnvMissingOnce(missing);
        setState({ status: "missing", missing });
        return;
      }

      setState({ status: "pending", missing });
    };

    RETRY_DELAYS_MS.forEach((delay, index) => {
      timers.push(window.setTimeout(() => runCheck(index === RETRY_DELAYS_MS.length - 1), delay));
    });

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [retryNonce]);

  const retry = useCallback(() => {
    setState({ status: "pending", missing: [] });
    setRetryNonce((value) => value + 1);
  }, []);

  if (state.status === "ready") return <>{children}</>;
  if (state.status === "pending") return <BackendConfigPending />;
  return <BackendConfigMissing missing={state.missing} onRetry={retry} />;
}

function BackendConfigPending() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-6 text-center">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <RefreshCw className="h-5 w-5 animate-spin text-primary" aria-hidden />
        <p className="text-sm">Checking backend configuration…</p>
      </div>
    </main>
  );
}

function BackendConfigMissing({ missing, onRetry }: { missing: PublicEnvName[]; onRetry: () => void }) {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-5">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Backend configuration
        </p>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-foreground">
          Backend configuration needed
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {getPublicBackendEnvMessage(missing)}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground active:scale-[0.98]"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Retry
        </button>
      </section>
    </main>
  );
}