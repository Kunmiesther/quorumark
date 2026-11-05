/**
 * ActivityDrawer — the desk's compact lower information area.
 *
 * One tabbed, collapsible drawer replaces the old stack of oversized bottom
 * cards. Purely presentational: every tab receives an already-wired panel as
 * a child node, so no data binding, query, or execution path changes here.
 */
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DrawerTab {
  key: string;
  label: string;
  /** Small count/status badge rendered next to the label. */
  badge?: ReactNode;
  content: ReactNode;
}

export function ActivityDrawer({
  tabs,
  defaultTab,
  right,
  summary,
  defaultExpanded = false,
}: {
  tabs: DrawerTab[];
  defaultTab?: string;
  right?: ReactNode;
  /** One-line status rendered while the drawer is collapsed. */
  summary?: ReactNode;
  defaultExpanded?: boolean;
}) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.key ?? "");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const current = tabs.find((t) => t.key === active) ?? tabs[0];


  return (
    <section
      className="relative w-full shrink-0 rounded-xl bg-[color:var(--surface-1)]"
      data-testid="activity-drawer"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-white/[0.06] px-2">
        <div
          role="tablist"
          aria-label="Desk activity"
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
        >
          {tabs.map((t) => {
            const on = t.key === current?.key;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={on}
                onClick={() => {
                  if (on && expanded) {
                    setExpanded(false);
                    return;
                  }
                  setActive(t.key);
                  setExpanded(true);
                }}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2 text-[10.5px] font-bold uppercase tracking-[0.14em] transition-colors",
                  on
                    ? "border-[color:var(--onixus-purple)] text-white"
                    : "border-transparent text-white/45 hover:text-white/80",
                )}
              >
                {t.label}
                {t.badge ? (
                  <span className="rounded bg-white/[0.08] px-1 py-px font-mono text-[9px] tabular-nums text-white/70">
                    {t.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2 pr-1">
          {right}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse drawer" : "Expand drawer"}
            className="rounded-md p-1 text-white/50 hover:bg-white/[0.05] hover:text-white"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {expanded ? (
        <div
          role="tabpanel"
          data-testid="activity-drawer-panel"
          className="relative w-full overflow-x-auto overflow-y-auto p-3"
          style={{ maxHeight: "clamp(260px, 42vh, 520px)" }}
        >
          {current?.content}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid="activity-drawer-summary"
          className="flex h-9 w-full items-center gap-3 overflow-hidden px-3 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-white/45 hover:text-white/75"
        >
          {summary ?? "Open activity"}
        </button>
      )}
    </section>
  );
}


