import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  readOnboardingDiagnostics,
  subscribeToOnboardingDiagnostics,
  type OnboardingDiagnosticEntry,
} from "@/lib/onboarding-diagnostics";

export function OnboardingDiagnosticsPanel() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [entries, setEntries] = useState<OnboardingDiagnosticEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setEntries(readOnboardingDiagnostics());
    return subscribeToOnboardingDiagnostics(setEntries);
  }, []);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open onboarding diagnostics"
        className="fixed bottom-3 right-3 z-50 rounded-full border border-primary/35 bg-background/90 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-primary shadow-glow backdrop-blur"
      >
        DEV
      </button>
    );
  }

  return (
    <aside className="fixed bottom-3 left-3 right-3 z-50 mx-auto max-w-md rounded-lg border border-primary/35 bg-background/95 p-3 font-mono text-[10px] leading-relaxed text-foreground shadow-glow backdrop-blur md:left-auto md:right-4 md:w-[360px]">
      <div className="mb-2 flex items-center justify-between gap-3 border-b border-border pb-2">
        <div className="min-w-0">
          <p className="text-[9px] uppercase text-muted-foreground">Onboarding diagnostics</p>
          <p className="truncate text-primary">{pathname}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-sm bg-primary px-2 py-1 text-[9px] font-bold text-primary-foreground">DEV</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Hide diagnostics"
            className="rounded-sm border border-border px-2 py-1 text-[9px] font-semibold text-muted-foreground hover:text-foreground"
          >
            Hide
          </button>
        </div>
      </div>
      <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
        {entries.length === 0 ? (
          <p className="text-muted-foreground">No route or guard events yet.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="rounded-md border border-border bg-surface p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-foreground">{entry.source}</span>
                <span className="shrink-0 text-muted-foreground">{entry.at}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-muted-foreground">
                <span>{entry.route}</span>
                <span className="text-primary">{entry.status}</span>
              </div>
              {entry.detail && <p className="mt-1 text-muted-foreground">{entry.detail}</p>}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}