import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, BarChart3, BrainCircuit, Cpu, LineChart, Plug, Radio, Users, Wallet } from "lucide-react";

const ITEMS = [
  { to: "/home", label: "Overview", icon: BarChart3 },
  { to: "/automation", label: "Automation", icon: BrainCircuit },
  { to: "/trade", label: "Trade", icon: LineChart },
  { to: "/signals", label: "Signals", icon: Radio },
  { to: "/orchestrator", label: "Onyx", icon: Cpu },
  { to: "/wallet", label: "Wallets", icon: Wallet },
  { to: "/exchanges", label: "Exchanges", icon: Plug },
  { to: "/squad", label: "Squad", icon: Users },
  { to: "/trades", label: "Activity", icon: Activity },
] as const;

export function TerminalNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Terminal"
      className="scrollbar-none -mx-3 mb-4 flex snap-x snap-mandatory items-center gap-1 overflow-x-auto px-3 pb-1"
    >
      {ITEMS.map(({ to, label, icon: Icon }) => {
        const active = pathname === to || pathname.startsWith(to + "/");
        return (
          <Link
            key={to}
            to={to}
            className={`inline-flex snap-start items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
              active
                ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200"
                : "border-white/5 bg-white/[0.02] text-muted-foreground hover:border-white/10 hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
