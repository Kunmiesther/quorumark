import { ReactNode, useEffect, useState } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  BrainCircuit,
  Home,
  Scale,
  FileCheck,
  Activity,
  Radar,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ProfileAvatar } from "./ProfileAvatar";
import { CommandPalette } from "./CommandPalette";
import { TopBar } from "./TopBar";
import { useAuth } from "@/hooks/useAuth";
// Client-side paper-tick scheduler removed — the cron endpoint is the
// single scheduling authority. See /api/public/hooks/paper-tick.
import { OnyxPanel, openOnyx, useOnyxOpen } from "@/components/onyx/OnyxPanel";
import { OnyxBeacon } from "@/components/onyx/OnyxBeacon";
import { ScoutPanel, openScout, useScoutOpen } from "@/components/scout/ScoutPanel";
import { ScoutFab } from "@/components/scout/ScoutFab";
import { BackButton } from "@/components/turtle/BackButton";
import { QuorumarkLogo } from "@/components/brand/QuorumarkLogo";

const SIDEBAR_KEY = "quorumark.sidebar.collapsed";

function backFallback(pathname: string) {
  if (pathname.startsWith("/profile/")) return "/profile";
  if (pathname.startsWith("/strategies/")) return "/strategies";
  if (pathname.startsWith("/admin/")) return "/profile";
  return "/home";
}

/**
 * Five canonical primary destinations. Life Map and Automation are first-class features.
 * Profile is NOT here — reached from the top-right avatar. Onyx is a FAB.
 */
const NAV = [
  { to: "/home", label: "Overview", icon: Home, match: ["/home", "/command"] },
  { to: "/agentic", label: "Agent Council", icon: BrainCircuit, match: ["/agentic", "/orchestrator"] },
  { to: "/life-map", label: "Policies", icon: Scale, match: ["/life-map", "/plan"] },
  { to: "/decisions", label: "Decisions", icon: FileCheck, match: ["/decisions"] },
  { to: "/notifications", label: "Activity", icon: Activity, match: ["/notifications", "/ops"] },
] as const;

/**
 * AppShell — three GENUINELY DISTINCT layouts.
 *
 *   MOBILE  (<768):    cinematic hero + fixed bottom tab bar
 *   TABLET  (md 768-1023): 72px left icon rail, no bottom bar
 *   DESKTOP (lg >=1024):   260px labeled sidebar + 64px top bar, cmd+K
 *
 * Onyx AI is not a destination. It is reachable everywhere via a purple
 * FAB (mobile/tablet) and a top-bar entry + ⌘K action (desktop). The
 * underlying route is /orchestrator, presented as "Onyx".
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const router = useRouter();
  const phoneDashboard = pathname === "/home";
  const isActive = (match: readonly string[]) =>
    match.some((p) => pathname === p || pathname.startsWith(p + "/"));

  const { user } = useAuth();
  const onyxOpen = useOnyxOpen();
  const scoutOpen = useScoutOpen();
  // Desktop sidebar collapse — collapsed by DEFAULT so the cockpit keeps its
  // width. Persisted so the desk keeps the operator's chosen width across
  // reloads. Read after mount to avoid hydration drift.
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_KEY);
      setCollapsed(stored == null ? true : stored === "1");
    } catch {
      /* storage unavailable — keep collapsed */
    }
  }, []);
  const toggleSidebar = () => {
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const sidebarWidth = collapsed ? "64px" : "210px";

  // Paper-tick loop intentionally NOT mounted — cron owns scheduling.

  // Deep-link hook: /home#onyx (used by the /orchestrator redirect) opens
  // the panel once, then clears the hash so reload doesn't reopen it.
  useEffect(() => {
    if (hash === "onyx" || hash === "#onyx") {
      openOnyx();
      router.navigate({ to: pathname, hash: "", replace: true });
    }
  }, [hash, pathname, router]);

  return (
    <div
      className="tb-neu-app tb-hard-surface min-h-[100dvh] bg-black text-white"
      style={{ ["--app-sidebar-w" as string]: sidebarWidth }}
    >
      {/* ============ TABLET RAIL (md 768-1023) ============ */}
      <aside
        aria-label="Primary"
        className="fixed inset-y-0 left-0 z-40 hidden w-[72px] flex-col bg-black/80 backdrop-blur md:flex lg:hidden"
      >
        <div className="flex h-16 items-center justify-center">
          <QuorumarkLogo compact />
        </div>
        <nav className="mt-2 flex-1 px-2">
          <ul className="space-y-1">
            {NAV.map(({ to, label, icon: Icon, match }) => {
              const active = isActive(match);
              return (
                <li key={to}>
                  <Link
                    to={to}
                    aria-current={active ? "page" : undefined}
                    title={label}
                    className={cn(
                      "flex h-11 items-center justify-center rounded-2xl transition-colors",
                      active
                        ? "bg-[color:var(--accent)]/20 text-white"
                        : "text-white/55 hover:bg-white/[0.04] hover:text-white",
                    )}
                  >
                    <Icon className="h-5 w-5" strokeWidth={2} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex flex-col items-center gap-3 pb-4">
          <ScoutFab compact />
          <OnyxFab compact />
          <ProfileAvatar />
        </div>
      </aside>

      {/* ============ DESKTOP SIDEBAR (lg >=1024) ============ */}
      <aside
        aria-label="Primary"
        data-collapsed={collapsed ? "true" : "false"}
        className="fixed inset-y-0 left-0 z-40 hidden w-[var(--app-sidebar-w)] flex-col overflow-y-auto overflow-x-hidden bg-[#050506] transition-[width] duration-200 lg:flex"
      >
        <div
          className={cn(
            "flex h-16 shrink-0 items-center",
            collapsed ? "justify-center px-2" : "justify-between px-6",
          )}
        >
          {collapsed ? (
            <QuorumarkLogo compact />
          ) : (
            <QuorumarkLogo />
          )}
        </div>
        <div className={cn("shrink-0 pb-2", collapsed ? "px-2" : "px-4")}>
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "flex h-8 items-center gap-2 rounded-lg text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45 transition-colors hover:bg-white/[0.05] hover:text-white",
              collapsed ? "w-full justify-center" : "w-full px-3",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" strokeWidth={2} />
            ) : (
              <>
                <PanelLeftClose className="h-4 w-4 shrink-0" strokeWidth={2} />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
        <nav className={cn("flex-1", collapsed ? "px-2" : "px-4")}>
          {!collapsed && (
            <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/35">
              Workspace
            </p>
          )}
          <ul className="space-y-1">
            {NAV.map(({ to, label, icon: Icon, match }) => {
              const active = isActive(match);
              return (
                <li key={to}>
                  <Link
                    to={to}
                    aria-current={active ? "page" : undefined}
                    title={label}
                    className={cn(
                      "group flex h-10 items-center rounded-xl text-[13.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]",
                      collapsed ? "justify-center px-0" : "gap-3 px-3",
                      active
                        ? "bg-[color:var(--accent)]/15 text-white"
                        : "text-white/60 hover:bg-white/[0.04] hover:text-white",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
                    {!collapsed && (
                      <>
                        <span className="truncate">{label}</span>
                        {active && (
                          <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--accent)]" />
                        )}
                      </>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 space-y-1 border-t border-white/[0.04] pt-3">
            <button
              type="button"
              onClick={() => openOnyx()}
              title="Ask Onyx"
              className={cn(
                "flex h-10 w-full items-center rounded-xl text-[13px] font-medium text-violet-200 transition-colors hover:bg-violet-400/10 hover:text-white",
                collapsed ? "justify-center" : "gap-3 px-3",
              )}
            >
              <Sparkles className="h-4 w-4 shrink-0" />
              {!collapsed && <span>Ask Onyx</span>}
            </button>
            <button
              type="button"
              onClick={() => openScout()}
              title="Open Scout"
              className={cn(
                "flex h-10 w-full items-center rounded-xl text-[13px] font-medium text-cyan-200 transition-colors hover:bg-cyan-400/10 hover:text-white",
                collapsed ? "justify-center" : "gap-3 px-3",
              )}
            >
              <Radar className="h-4 w-4 shrink-0" />
              {!collapsed && <span>Scout</span>}
            </button>
          </div>
        </nav>
        {/* Account block pinned to bottom */}
        <div className={cn("shrink-0 border-t border-white/[0.04]", collapsed ? "p-2" : "p-4")}>
          <Link
            to="/profile"
            title="Account · Settings"
            className={cn(
              "flex items-center rounded-xl p-2 transition-colors hover:bg-white/[0.04]",
              collapsed ? "justify-center" : "gap-3",
            )}
          >
            <ProfileAvatar />
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-white">
                  {user?.email?.split("@")[0] ?? "Operator"}
                </p>
                <p className="text-[11px] text-white/45">Account · Settings</p>
              </div>
            )}
          </Link>
        </div>
      </aside>

      {/* ============ DESKTOP TOP BAR (lg >=1024) ============ */}
      <TopBar />

      {/* ============ MAIN CONTENT ============ */}
      <main
        className={cn(
          "min-h-[100dvh] pb-[calc(72px+env(safe-area-inset-bottom))] transition-[padding] duration-200 md:pb-0 md:pl-[72px] lg:pl-[var(--app-sidebar-w)] lg:pt-16",
          // desktop only: reflow when panels are open (push, not overlay)
          onyxOpen && "lg:pr-[420px]",
          scoutOpen && "lg:pl-[calc(var(--app-sidebar-w)+420px)]",
        )}
      >
        {pathname !== "/home" && (
          <BackButton
            fallback={backFallback(pathname)}
            iconOnly
            className="fixed left-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[70] md:left-[84px] lg:left-[calc(var(--app-sidebar-w)+12px)] lg:top-[76px]"
          />
        )}
        <div
          className={cn(
            "mx-auto w-full",
            phoneDashboard ? "max-w-[430px] md:max-w-none lg:max-w-[1760px]" : "lg:max-w-[1760px]",
          )}
        >
          {children}
        </div>
      </main>

      {/* ============ MOBILE BOTTOM TAB BAR (only <768) ============ */}
      <nav
        aria-label="Primary"
        className={cn(
          "fixed bottom-0 z-40 border-t border-white/[0.06] bg-black/85 backdrop-blur md:hidden",
          phoneDashboard ? "left-1/2 w-full max-w-[430px] -translate-x-1/2" : "inset-x-0 md:hidden",
        )}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="mx-auto flex max-w-md items-stretch justify-between px-2 pt-2">
          {NAV.map(({ to, label, icon: Icon, match }) => {
            const active = isActive(match);
            return (
              <li key={to} className="flex-1">
                <Link
                  to={to}
                  aria-current={active ? "page" : undefined}
                  aria-label={label}
                  className={cn(
                    "flex min-h-[44px] flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-2 text-[10.5px] font-medium transition-colors",
                    active ? "text-white" : "text-white/50",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-8 w-12 items-center justify-center rounded-full transition-colors",
                      active && "bg-[color:var(--accent)]/20",
                    )}
                  >
                    <Icon className="h-5 w-5" strokeWidth={2} />
                  </span>
                  <span>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Home exposes Onyx as a quick action and keeps its chart unobstructed. */}
      {pathname !== "/home" && pathname !== "/trade" ? (
        <div
          className="fixed right-4 z-50 flex flex-col items-center gap-2 md:hidden"
          style={{ bottom: "calc(88px + env(safe-area-inset-bottom))" }}
        >
          <ScoutFab />
          <OnyxFab />
        </div>
      ) : null}

      {/* Global cmd+K launcher */}
      <CommandPalette />

      {/* Global Onyx panel — bottom sheet / side panel */}
      <OnyxPanel />

      {/* Global Scout panel — bottom sheet / side panel (mirrors Onyx) */}
      <ScoutPanel />
    </div>
  );
}

function OnyxFab({ compact = false }: { compact?: boolean }) {
  return <OnyxBeacon variant="fab" className={compact ? "scale-90" : undefined} />;
}
