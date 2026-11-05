import { Link, useRouterState } from "@tanstack/react-router";
import { BrainCircuit, Compass, Home, LineChart, Plug } from "lucide-react";

/**
 * Legacy compact bottom nav. The canonical primary nav lives in
 * `AppShell`; this component is kept for legacy screens and mirrors the
 * same simplified order: Home, Life Map, Automation, Trade, Exchanges.
 */
export const BOTTOM_NAV_ITEMS = [
  { to: "/home", label: "Home", icon: Home, match: ["/home", "/command"] },
  { to: "/life-map", label: "Life Map", icon: Compass, match: ["/life-map"] },
  { to: "/automation", label: "Automation", icon: BrainCircuit, match: ["/automation"] },
  { to: "/trade", label: "Trade", icon: LineChart, match: ["/trade", "/trades", "/signals"] },
  { to: "/exchanges", label: "Exchanges", icon: Plug, match: ["/exchanges", "/wallet"] },
] as const;


export function BottomNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-frame/95 backdrop-blur supports-[backdrop-filter]:bg-frame/80"
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-between px-2 pb-[env(safe-area-inset-bottom)] pt-2">
        {BOTTOM_NAV_ITEMS.map(({ to, label, icon: Icon, match }) => {
          const active = match.some((p) => pathname === p || pathname.startsWith(p + "/"));
          return (
            <li key={to} className="flex-1">
              <Link
                to={to}
                aria-current={active ? "page" : undefined}
                aria-label={label}
                className={`flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-medium transition-colors ${
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={2} />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
