import { useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { ProfileAvatar } from "./ProfileAvatar";
import { KbdHint, openCommandPalette } from "./CommandPalette";

const TITLES: Record<string, string> = {
  "/home": "Overview",
  "/agentic": "Agent Council",
  "/decisions": "Decisions",
  "/life-map": "Policies",
  "/notifications": "Activity",
  "/profile": "Profile & Settings",
  "/orchestrator": "Agent Council",
};

function titleFor(pathname: string): string {
  if (TITLES[pathname]) return TITLES[pathname];
  const base = "/" + pathname.split("/").filter(Boolean)[0];
  return TITLES[base] ?? "Quorumark";
}

/**
 * TopBar — desktop only (lg >=1024). Fixed 64px top bar with cmd+K search
 * and an Ask-Onyx entry.
 */
export function TopBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const title = titleFor(pathname);
  const tradingDesk =
    pathname === "/trade" || pathname.startsWith("/trade/") || pathname === "/exchanges";

  return (
    <header
      className="fixed inset-x-0 top-0 z-30 hidden h-16 items-center gap-4 border-b border-white/[0.04] bg-black/85 px-8 backdrop-blur lg:flex"
      style={{ paddingLeft: "calc(var(--app-sidebar-w, 260px) + 32px)" }}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-[0.16em] text-white/40">
          {tradingDesk ? "Quorumark · legacy execution hidden" : "Quorumark"}
        </p>
        <h1 className="truncate text-[15px] font-semibold text-white">
          {tradingDesk ? "Legacy execution surface" : title}
        </h1>
      </div>

      {tradingDesk ? (
        <div className="flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-300">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]" />
          Trading operations
        </div>
      ) : (
        <button
          onClick={() => openCommandPalette()}
          className="flex max-w-[380px] flex-1 items-center gap-3 rounded-full bg-white/[0.05] px-4 py-2 text-[13px] text-white/50 transition hover:bg-white/[0.08] hover:text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          aria-label="Open command palette"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">Search pages, actions…</span>
          <KbdHint />
        </button>
      )}

      <div className="flex items-center gap-3">
        <ProfileAvatar />
      </div>
    </header>
  );
}
