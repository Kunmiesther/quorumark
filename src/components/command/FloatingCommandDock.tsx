import { Link } from "@tanstack/react-router";
import { BrainCircuit, Compass, Home as HomeIcon, LineChart, Plug } from "lucide-react";

/**
 * Floating command dock — canonical 5 destinations, matching AppShell:
 * Home, Life Map, Automation, Trade, Exchanges. Strategy selection lives on Home.
 */
const ITEMS = [
  { to: "/home", label: "Home", Icon: HomeIcon },
  { to: "/life-map", label: "Life Map", Icon: Compass },
  { to: "/automation", label: "Automation", Icon: BrainCircuit },
  { to: "/trade", label: "Trade", Icon: LineChart },
  { to: "/exchanges", label: "Exchanges", Icon: Plug },
] as const;

export function FloatingCommandDock() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4"
      style={{
        paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
      }}
    >
      <div
        className="command-surface flex w-full max-w-md items-stretch gap-1 px-2 py-1.5"
        style={{
          background:
            "linear-gradient(180deg, rgba(16,21,28,0.85), rgba(7,9,13,0.9))",
          borderColor: "rgba(244,247,250,0.09)",
          backdropFilter: "blur(20px) saturate(140%)",
        }}
      >
        {ITEMS.map(({ to, label, Icon }) => (
          <Link
            key={to}
            to={to}
            aria-label={label}
            className="group relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] px-2 py-1.5 text-[color:var(--text-secondary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--brand-violet)]"
            activeProps={{
              className:
                "text-[color:var(--text-primary)] bg-[color:hsl(var(--brand-violet)/0.14)]",
            }}
            activeOptions={{ exact: false }}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
            <span className="text-[9.5px] font-medium uppercase tracking-[0.14em]">
              {label}
            </span>
            {/* Active indicator pill — only rendered for the active item via
                the data-status="active" attribute TanStack adds. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-3 -bottom-0.5 h-[2px] rounded-full opacity-0 group-data-[status=active]:opacity-100"
              style={{ background: "hsl(var(--brand-violet))" }}
            />
          </Link>
        ))}
      </div>
    </nav>
  );
}
