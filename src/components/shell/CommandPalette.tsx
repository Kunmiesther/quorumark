import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Command as CommandIcon,
  Home,
  LineChart,
  Plug,
  User,
  Compass,
  Search,
  Sparkles,
  
  Radar,
  BrainCircuit,
} from "lucide-react";
import { openOnyx } from "@/components/onyx/OnyxPanel";
import { openScout } from "@/components/scout/ScoutPanel";

type PaletteItem = {
  key: string;
  label: string;
  icon: typeof Home;
  hint: string;
  to?: string;
  action?: () => void;
};

const ITEMS: PaletteItem[] = [
  { key: "home", to: "/home", label: "Home", icon: Home, hint: "Dashboard overview" },
  { key: "life-map", to: "/life-map", label: "Life Map", icon: Compass, hint: "Goals & stability" },
  { key: "automation", to: "/automation", label: "Automation", icon: BrainCircuit, hint: "Autopilot plans and safety gates" },
  { key: "trade", to: "/trade", label: "Trade", icon: LineChart, hint: "Positions, signals, activity" },
  { key: "exchanges", to: "/exchanges", label: "Exchanges", icon: Plug, hint: "Keys, wallets, permissions" },
  // Paper Test lives inside the Trade page's book toggle (owner ruling —
  // UI consolidation). No separate palette entry.

  { key: "scout", action: () => openScout(), label: "Open Scout", icon: Radar, hint: "Recon & defense — MTF intelligence" },
  { key: "onyx", action: () => openOnyx(), label: "Open Onyx", icon: Sparkles, hint: "AI decision layer" },
  { key: "decisions", to: "/decisions", label: "AI Decision Room", icon: Sparkles, hint: "Recorded evaluations: 3 seats, verdict, terminal outcome" },
  { key: "agentic", to: "/agentic", label: "Agentic Command Center", icon: Sparkles, hint: "Agent health, position management, paper performance, promotion gate" },
  { key: "profile", to: "/profile", label: "Profile & Settings", icon: User, hint: "Account, security, billing, notifications" },
];

// Module-level opener — TopBar (or any peer) calls openCommandPalette()
// to open the palette without dispatching a synthetic KeyboardEvent.
let openHandle: (() => void) | null = null;
export function openCommandPalette() {
  openHandle?.();
}


/**
 * CommandPalette — desktop (lg >=1024) cmd+K launcher.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    openHandle = () => {
      setOpen(true);
      setQuery("");
      setCursor(0);
    };
    return () => {
      openHandle = null;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery("");
        setCursor(0);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const q = query.trim().toLowerCase();
  const items = q
    ? ITEMS.filter((i) => i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q))
    : ITEMS;

  if (!open) return null;

  function run(item: PaletteItem) {
    setOpen(false);
    if (item.action) item.action();
    else if (item.to) navigate({ to: item.to });
  }


  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[80] hidden items-start justify-center bg-black/60 px-4 pt-[10vh] backdrop-blur-sm lg:flex"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-[600px] overflow-hidden rounded-3xl bg-[#0b0b0d] shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <Search className="h-4 w-4 text-white/50" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter" && items[cursor]) {
                run(items[cursor]);
              }

            }}
            placeholder="Search pages, actions…"
            className="flex-1 bg-transparent text-[15px] text-white placeholder-white/40 outline-none"
          />
          <kbd className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white/60">
            ESC
          </kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto border-t border-white/[0.06] py-2">
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-white/50">No results.</p>
          ) : (
            items.map((i, idx) => {
              const Icon = i.icon;
              const active = idx === cursor;
              return (
                <button
                  key={i.key}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => run(i)}
                  className={

                    "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors " +
                    (active ? "bg-white/[0.06]" : "")
                  }
                >
                  <Icon className="h-4 w-4 text-white/60" />
                  <span className="flex-1 text-[14px] font-medium text-white">{i.label}</span>
                  <span className="text-[12px] text-white/40">{i.hint}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export function KbdHint() {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(typeof navigator !== "undefined" && /mac/i.test(navigator.platform));
  }, []);
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-white/60">
      <CommandIcon className="h-3 w-3" />
      {mac ? "K" : "Ctrl K"}
    </span>
  );
}
