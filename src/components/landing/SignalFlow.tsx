import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import { Radar, Brain, CheckCircle2, Wallet, Target, Activity } from "lucide-react";

/**
 * SignalFlow — the section directly below the Hero.
 *
 * Visual continuation of the hero: dark space, moving thin chart lines,
 * cyan/teal glow, compact animated widgets. It shows the causal path
 * MARKET DATA → SCOUT → ONYX → APPROVED ACTION → AVAILABLE FUNDS →
 * LIFE MAP GOAL as a live, breathing system rather than a card grid.
 *
 * All numbers are demonstration data and labeled as such.
 */

const NODES = [
  { key: "market", label: "Market data", sub: "BTC · ETH · SOL feed", icon: Activity, tone: "cyan" },
  { key: "scout", label: "Scout", sub: "scanning BTC · XRP · SOL · ETH", icon: Radar, tone: "cyan" },
  { key: "onyx", label: "Onyx", sub: "evaluating opportunity", icon: Brain, tone: "violet" },
  { key: "approved", label: "Approved action", sub: "long BTC · +1.2R target", icon: CheckCircle2, tone: "emerald" },
  { key: "funds", label: "Available funds", sub: "$1,883.95", icon: Wallet, tone: "teal" },
  { key: "goal", label: "Emergency Fund", sub: "+ $125.00 routed", icon: Target, tone: "cyan" },
] as const;

type Tone = (typeof NODES)[number]["tone"];

const TONE_TEXT: Record<Tone, string> = {
  cyan: "text-cyan-300",
  violet: "text-violet-300",
  emerald: "text-emerald-300",
  teal: "text-teal-300",
};

const TONE_RING: Record<Tone, string> = {
  cyan: "ring-cyan-400/30 shadow-[0_0_28px_-6px_rgba(34,211,238,0.55)]",
  violet: "ring-violet-400/30 shadow-[0_0_28px_-6px_rgba(167,139,250,0.55)]",
  emerald: "ring-emerald-400/30 shadow-[0_0_28px_-6px_rgba(52,211,153,0.55)]",
  teal: "ring-teal-400/30 shadow-[0_0_28px_-6px_rgba(45,212,191,0.55)]",
};

export function SignalFlow({ beacon }: { beacon?: ReactNode } = {}) {
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % NODES.length), 1400);
    return () => window.clearInterval(id);
  }, [reduce]);

  return (
    <section
      aria-label="How TurtleBot turns market signal into real-life progress"
      className="relative isolate overflow-hidden border-t border-white/[0.04] bg-[#04060B] pt-20 pb-6 sm:pt-28 sm:pb-8"
    >
      <BackgroundLines reduce={!!reduce} />

      <div className="relative mx-auto w-full max-w-6xl px-5 sm:px-8">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex flex-col items-start gap-3">
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.32em] text-cyan-300/80">
              Signal flow · live system
            </span>
            <h2
              className="max-w-3xl font-display text-[34px] font-semibold uppercase leading-[1.05] tracking-[-0.01em] text-white sm:text-[44px] md:text-[52px]"
            >
              From market signal
              <br />
              <span className="text-white/55">to real-life progress.</span>
            </h2>
            <p className="max-w-2xl text-[14px] leading-relaxed text-white/60 md:text-[16px]">
              TurtleBot receives information, evaluates the opportunity, and connects
              approved results back to the goals that matter.
            </p>
          </div>
          {beacon ? (
            <div className="flex justify-center lg:justify-end">{beacon}</div>
          ) : null}
        </div>


        {/* Flow rail */}
        <div className="relative mt-14">
          {/* Desktop connective rail */}
          <div className="pointer-events-none absolute inset-x-0 top-[46px] hidden h-px lg:block">
            <div className="mx-auto h-px w-full max-w-5xl bg-gradient-to-r from-transparent via-cyan-400/25 to-transparent" />
          </div>

          <ol className="relative grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6 lg:gap-3">
            {NODES.map((node, i) => {
              const active = !reduce && tick === i;
              const Icon = node.icon;
              return (
                <li key={node.key} className="relative flex flex-col items-center gap-3 text-center">
                  {/* Local connector to next node (desktop only) */}
                  {i < NODES.length - 1 && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute right-[-6px] top-[46px] hidden h-px w-3 bg-cyan-400/40 lg:block"
                    />
                  )}
                  <motion.div
                    animate={
                      active
                        ? { scale: 1.06 }
                        : { scale: 1 }
                    }
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className={`relative grid h-[92px] w-full max-w-[160px] place-items-center rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm ring-1 transition-colors ${
                      active ? TONE_RING[node.tone] : "ring-white/[0.04]"
                    }`}
                  >
                    <div className="flex flex-col items-center gap-1.5">
                      <div className={`flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/40 ${TONE_TEXT[node.tone]}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <span className={`font-mono text-[10px] uppercase tracking-[0.22em] ${active ? TONE_TEXT[node.tone] : "text-white/55"}`}>
                        {node.label}
                      </span>
                    </div>
                    {/* Traveling pulse dot arrives at active node */}
                    {active && (
                      <motion.span
                        aria-hidden
                        initial={{ opacity: 0, scale: 0.4 }}
                        animate={{ opacity: [0, 1, 0], scale: [0.4, 1.4, 1.8] }}
                        transition={{ duration: 1.1, ease: "easeOut" }}
                        className={`pointer-events-none absolute inset-0 rounded-2xl ring-1 ${TONE_RING[node.tone]}`}
                      />
                    )}
                  </motion.div>
                  <p className="min-h-[32px] text-[11px] leading-snug text-white/55">{node.sub}</p>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Live widgets row */}
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <TickerWidget />
          <ApprovalWidget />
          <GoalWidget />
        </div>

        <p className="mt-6 text-center text-[10px] uppercase tracking-[0.24em] text-white/35">
          Demonstration data
        </p>
      </div>
    </section>
  );
}

/* ---------------- background thin chart lines ---------------- */

function BackgroundLines({ reduce }: { reduce: boolean }) {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.35]"
      preserveAspectRatio="none"
      viewBox="0 0 1200 600"
    >
      <defs>
        <linearGradient id="sf-line" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#22D3EE" stopOpacity="0" />
          <stop offset="50%" stopColor="#22D3EE" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sf-line-teal" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#2DD4BF" stopOpacity="0" />
          <stop offset="50%" stopColor="#2DD4BF" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#2DD4BF" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[
        { d: "M0,120 C220,90 420,180 640,140 C860,100 1040,170 1200,130", stroke: "url(#sf-line)", w: 1 },
        { d: "M0,320 C240,290 460,360 700,320 C900,286 1050,340 1200,300", stroke: "url(#sf-line-teal)", w: 0.8 },
        { d: "M0,500 C260,470 480,520 720,490 C920,466 1080,510 1200,480", stroke: "url(#sf-line)", w: 0.8 },
      ].map((l, i) => (
        <motion.path
          key={i}
          d={l.d}
          fill="none"
          stroke={l.stroke}
          strokeWidth={l.w}
          initial={{ pathLength: 0.2, opacity: 0.6 }}
          animate={reduce ? {} : { pathLength: [0.2, 1, 0.2], opacity: [0.4, 0.9, 0.4] }}
          transition={{ duration: 9 + i * 2, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </svg>
  );
}

/* ---------------- widgets ---------------- */

function TickerWidget() {
  const reduce = useReducedMotion();
  const [price, setPrice] = useState(64218.42);
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => {
      setPrice((p) => p + (Math.random() - 0.45) * 18);
    }, 900);
    return () => window.clearInterval(id);
  }, [reduce]);
  const up = price >= 64218.42;
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-300/80">
          Market signal
        </p>
        <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/25 bg-cyan-400/[0.06] px-2 py-0.5 text-[10px] text-cyan-300">
          <span className="h-1 w-1 rounded-full bg-cyan-300" />
          received
        </span>
      </div>
      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-[13px] text-white/70">BTC/USDT</span>
        <span className={`font-display text-[22px] font-semibold tabular-nums ${up ? "text-emerald-300" : "text-rose-300"}`}>
          ${price.toFixed(2)}
        </span>
      </div>
      <MiniSpark reduce={!!reduce} />
    </div>
  );
}

function ApprovalWidget() {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/80">
          Onyx decision
        </p>
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-400/[0.06] px-2 py-0.5 text-[10px] text-emerald-300">
          <CheckCircle2 className="h-3 w-3" />
          approved
        </span>
      </div>
      <ul className="mt-3 space-y-1.5 text-[12px] text-white/70">
        <Row k="Strategy" v="Accumulator · long" />
        <Row k="Size" v="0.014 BTC" />
        <Row k="Risk" v="0.6% of equity" />
        <Row k="Confidence" v="0.72" />
      </ul>
    </div>
  );
}

function GoalWidget() {
  const reduce = useReducedMotion();
  const target = 5000;
  const [progress, setProgress] = useState(2875);
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => {
      setProgress((p) => {
        const next = p + 125;
        return next > target ? 2875 : next;
      });
    }, 4200);
    return () => window.clearInterval(id);
  }, [reduce, target]);
  const pct = Math.min(100, (progress / target) * 100);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-teal-300/80">
          Life Map goal
        </p>
        <motion.span
          key={progress}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="inline-flex items-center gap-1 rounded-full border border-cyan-400/25 bg-cyan-400/[0.06] px-2 py-0.5 text-[10px] text-cyan-300"
        >
          + $125.00 routed
        </motion.span>
      </div>
      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-[13px] text-white/70">Emergency Fund</span>
        <span className="font-display text-[18px] font-semibold text-white tabular-nums">
          ${progress.toLocaleString()}{" "}
          <span className="text-[12px] text-white/45">/ ${target.toLocaleString()}</span>
        </span>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-teal-300 shadow-[0_0_18px_-2px_rgba(34,211,238,0.7)]"
        />
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-white/50">{k}</span>
      <span className="tabular-nums text-white/85">{v}</span>
    </li>
  );
}

function MiniSpark({ reduce }: { reduce: boolean }) {
  return (
    <svg viewBox="0 0 200 40" className="mt-3 h-10 w-full">
      <defs>
        <linearGradient id="sf-spark" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#22D3EE" stopOpacity="0" />
          <stop offset="50%" stopColor="#22D3EE" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#2DD4BF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path
        d="M0,28 L20,22 L38,26 L58,14 L78,20 L98,10 L118,18 L138,8 L158,16 L180,6 L200,12"
        fill="none"
        stroke="url(#sf-spark)"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0.3 }}
        animate={reduce ? {} : { pathLength: [0.3, 1, 0.3] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />
    </svg>
  );
}
