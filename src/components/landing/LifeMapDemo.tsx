import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Home, CreditCard, Shield, Sparkles, Hammer, Sunrise, ArrowRight } from "lucide-react";

/* ============================================================
   Life Map — narrative donut. Each pillar tells a small story
   about what TurtleBot is quietly doing with the user's money.
   ============================================================ */

type CategoryKey = "live" | "owe" | "protect" | "grow" | "build" | "future";

interface Pillar {
  key: CategoryKey;
  label: string;
  blurb: string;
  icon: React.ComponentType<any>;
  color: string;
  target: number;
  funded: number;
  // Narrative fields
  story: string;      // What TurtleBot is doing right now
  proof: string;      // Concrete, human proof point
  nextMove: string;   // What the next dollar unlocks
}

// Cyan → teal → violet spectrum. Copy is written to feel human, not corporate.
const PILLARS: Pillar[] = [
  {
    key: "live",
    label: "Live",
    blurb: "Rent, food, power",
    icon: Home,
    color: "#22d3ee",
    target: 2730,
    funded: 2370,
    story: "This month's rent is 87% pre-funded from verified trading profits.",
    proof: "Rent · Groceries · Utilities queued",
    nextMove: "$360 more clears November in full.",
  },
  {
    key: "owe",
    label: "Owe",
    blurb: "Cards, car, loans",
    icon: CreditCard,
    color: "#38bdf8",
    target: 23870,
    funded: 403,
    story: "First dents in the card balance — small, but every payment is real.",
    proof: "Auto-pays $50 above minimum weekly.",
    nextMove: "On pace to be debt-free in 4.2 years.",
  },
  {
    key: "protect",
    label: "Protect",
    blurb: "Emergency, insurance",
    icon: Shield,
    color: "#2dd4bf",
    target: 16500,
    funded: 3750,
    story: "Building the 6-month cushion — the one that lets you sleep.",
    proof: "$3,750 held aside. That's ~1.4 months of expenses.",
    nextMove: "TurtleBot fills this before it funds any goal.",
  },
  {
    key: "grow",
    label: "Grow",
    blurb: "Vacation, family, home",
    icon: Sparkles,
    color: "#818cf8",
    target: 6500,
    funded: 1900,
    story: "Kyoto in spring — flights already 60% funded.",
    proof: "Vacation jar: $1,900 · Home refresh: $0",
    nextMove: "$700 more books the tickets outright.",
  },
  {
    key: "build",
    label: "Build",
    blurb: "Business, first home",
    icon: Hammer,
    color: "#a78bfa",
    target: 63000,
    funded: 9700,
    story: "Down-payment engine running quietly in the background.",
    proof: "15% of a starter home saved without touching salary.",
    nextMove: "Every $5k profit skips a year off the timeline.",
  },
  {
    key: "future",
    label: "Future",
    blurb: "Retirement, legacy",
    icon: Sunrise,
    color: "#c084fc",
    target: 350000,
    funded: 15600,
    story: "The long game — untouched, compounding, patient.",
    proof: "Locked away. Onyx never routes trading capital here.",
    nextMove: "At $600/mo, you cross $1M by 2054.",
  },
];

// Log-scale weights so small pillars remain visible next to huge ones.
const weightOf = (v: number) => Math.log10(v + 1);

export function LifeMapDemo({ showHeader = true }: { showHeader?: boolean } = {}) {
  const [active, setActive] = useState<CategoryKey>("protect");

  const totals = useMemo(() => {
    const target = PILLARS.reduce((s, p) => s + p.target, 0);
    const funded = PILLARS.reduce((s, p) => s + p.funded, 0);
    return { target, funded, pct: (funded / target) * 100 };
  }, []);

  const segments = useMemo(() => {
    const totalW = PILLARS.reduce((s, p) => s + weightOf(p.target), 0);
    let cursor = 0;
    return PILLARS.map((p) => {
      const frac = weightOf(p.target) / totalW;
      const start = cursor;
      const end = cursor + frac;
      cursor = end;
      return { pillar: p, start, end, frac };
    });
  }, []);

  const activePillar = PILLARS.find((p) => p.key === active)!;
  const R = 78;
  const r = 54;
  const C = 100;

  // Build an SVG arc path for a donut segment.
  const arcPath = (startFrac: number, endFrac: number) => {
    const pad = 0.006;
    const a0 = (startFrac + pad) * Math.PI * 2 - Math.PI / 2;
    const a1 = (endFrac - pad) * Math.PI * 2 - Math.PI / 2;
    const large = endFrac - startFrac > 0.5 ? 1 : 0;
    const x0o = C + R * Math.cos(a0), y0o = C + R * Math.sin(a0);
    const x1o = C + R * Math.cos(a1), y1o = C + R * Math.sin(a1);
    const x0i = C + r * Math.cos(a1), y0i = C + r * Math.sin(a1);
    const x1i = C + r * Math.cos(a0), y1i = C + r * Math.sin(a0);
    return `M${x0o},${y0o} A${R},${R} 0 ${large} 1 ${x1o},${y1o} L${x0i},${y0i} A${r},${r} 0 ${large} 0 ${x1i},${y1i} Z`;
  };

  return (
    <section id="life-map" className="relative overflow-hidden bg-[#04060B] pt-6 pb-16 sm:pt-8 sm:pb-20">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/25 to-transparent" />

      <div className="relative mx-auto max-w-5xl px-6">
        {showHeader && (
          <div className="mx-auto max-w-2xl text-center">
            <div className="mb-3 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300/80">
              <span className="h-px w-6 bg-cyan-300/40" />
              The Life Map
              <span className="h-px w-6 bg-cyan-300/40" />
            </div>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Your money, mapped to your life.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/60 sm:text-base">
              Six pillars. One picture. TurtleBot routes verified earnings across every part of your life.
            </p>
          </div>
        )}

        {/* Narrative rail — the money's journey */}
        <div className="mt-6 grid grid-cols-3 items-stretch overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.015] text-left">
          <RailStep
            eyebrow="Verified earnings"
            value="$4,812"
            hint="this month, net of fees"
            tone="cyan"
          />
          <RailStep
            eyebrow="Onyx routed"
            value="6 pillars"
            hint="rules-based, no guesswork"
            tone="teal"
            withArrow
          />
          <RailStep
            eyebrow="Life covered"
            value={`${totals.pct.toFixed(1)}%`}
            hint={`$${Math.round(totals.funded / 1000)}k of $${Math.round(totals.target / 1000)}k lifetime plan`}
            tone="violet"
            withArrow
          />
        </div>

        {/* Chart card */}
        <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5 backdrop-blur-sm sm:p-8">
          <div className="grid items-center gap-8 sm:grid-cols-[minmax(0,220px)_1fr]">
            {/* Donut */}
            <div className="relative mx-auto aspect-square w-full max-w-[220px]">
              <div className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_center,rgba(34,211,238,0.35),rgba(167,139,250,0.18)_45%,transparent_70%)] blur-2xl" />
              <svg viewBox="0 0 200 200" className="h-full w-full">
                {segments.map(({ pillar, start, end }) => {
                  const isActive = pillar.key === active;
                  return (
                    <motion.path
                      key={pillar.key}
                      d={arcPath(start, end)}
                      fill={pillar.color}
                      opacity={isActive ? 1 : 0.42}
                      onClick={() => setActive(pillar.key)}
                      className="cursor-pointer transition-opacity hover:opacity-90"
                      style={{ filter: isActive ? `drop-shadow(0 0 8px ${pillar.color}aa)` : "none" }}
                      initial={{ opacity: 0 }}
                      whileInView={{ opacity: isActive ? 1 : 0.42 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.6 }}
                    />
                  );
                })}
              </svg>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-white/40">Covered</div>
                <div className="font-display text-2xl font-semibold text-white">
                  {totals.pct.toFixed(1)}%
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-white/50">
                  ${Math.round(totals.funded / 1000)}k / ${Math.round(totals.target / 1000)}k
                </div>
              </div>
            </div>

            {/* Legend */}
            <div className="grid grid-cols-2 gap-2">
              {PILLARS.map((p) => {
                const Icon = p.icon;
                const pct = (p.funded / p.target) * 100;
                const isActive = p.key === active;
                return (
                  <button
                    key={p.key}
                    onClick={() => setActive(p.key)}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                      isActive
                        ? "border-white/20 bg-white/[0.05]"
                        : "border-white/5 bg-transparent hover:border-white/10 hover:bg-white/[0.03]"
                    }`}
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                      style={{ background: `${p.color}18`, border: `1px solid ${p.color}44` }}
                    >
                      <Icon className="h-3.5 w-3.5" color={p.color} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-display text-sm font-medium text-white">
                          {p.label}
                        </span>
                        <span className="font-mono text-[10px] text-white/60">{pct.toFixed(0)}%</span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.min(pct, 100)}%`, background: p.color }}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active pillar story — this is what "speaks to the audience" */}
          <motion.div
            key={activePillar.key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="mt-6 overflow-hidden rounded-xl border bg-black/40"
            style={{
              borderColor: `${activePillar.color}33`,
              boxShadow: `inset 0 0 0 1px ${activePillar.color}0f, 0 0 40px -20px ${activePillar.color}66`,
            }}
          >
            <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-2">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: activePillar.color, boxShadow: `0 0 10px ${activePillar.color}` }}
              />
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-white/50">
                Onyx is routing to
              </span>
              <span
                className="font-display text-[11px] font-semibold uppercase tracking-[0.18em]"
                style={{ color: activePillar.color }}
              >
                {activePillar.label}
              </span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.24em] text-white/30">
                Demo data
              </span>
            </div>
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-[1.4fr_1fr_1fr]">
              <div>
                <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-white/40">
                  The story
                </div>
                <p className="mt-1 font-display text-[14px] leading-snug text-white">
                  {activePillar.story}
                </p>
              </div>
              <div>
                <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-white/40">
                  What's real today
                </div>
                <p className="mt-1 text-[12.5px] leading-snug text-white/75">
                  {activePillar.proof}
                </p>
              </div>
              <div>
                <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-white/40">
                  Next dollar unlocks
                </div>
                <p className="mt-1 text-[12.5px] leading-snug text-white/75">
                  {activePillar.nextMove}
                </p>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function RailStep({
  eyebrow,
  value,
  hint,
  tone,
  withArrow,
}: {
  eyebrow: string;
  value: string;
  hint: string;
  tone: "cyan" | "teal" | "violet";
  withArrow?: boolean;
}) {
  const color =
    tone === "cyan" ? "#22d3ee" : tone === "teal" ? "#2dd4bf" : "#a78bfa";
  return (
    <div className="relative flex items-center gap-3 px-4 py-3 sm:px-5">
      {withArrow && (
        <ArrowRight
          className="absolute -left-2 top-1/2 hidden h-3 w-3 -translate-y-1/2 text-white/25 sm:block"
          aria-hidden
        />
      )}
      <span
        className="h-8 w-[2px] rounded-full"
        style={{ background: color, boxShadow: `0 0 12px ${color}` }}
      />
      <div className="min-w-0">
        <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-white/45">
          {eyebrow}
        </div>
        <div className="font-display text-[15px] font-semibold text-white">
          {value}
        </div>
        <div className="truncate font-mono text-[10px] text-white/40">{hint}</div>
      </div>
    </div>
  );
}
