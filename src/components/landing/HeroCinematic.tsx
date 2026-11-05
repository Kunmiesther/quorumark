import { Link } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Lock, Activity, ShieldCheck } from "lucide-react";
import { turtleCollective } from "@/lib/marketing/data";

/**
 * HeroCinematic — the opening scene.
 *
 * A living data-scape. Market ribbons flow left→right, Scout scans the
 * horizon, Onyx floats above as a sleek intelligence core receiving
 * signal beams, and Life-Map goal orbs pulse below waiting to be
 * funded. Typography sits on top like a movie title card.
 *
 * No dashboard screenshot, no stock robot. Every visual element is
 * generated in SVG/DOM so it stays crisp on any DPR and respects
 * reduced-motion.
 */
export function HeroCinematic() {
  const reduce = useReducedMotion();
  const scoutPortrait = turtleCollective.find((t) => t.key === "scout")!.portrait;

  return (
    <section className="relative isolate min-h-[100svh] w-full overflow-hidden bg-[#07070b] pt-24 sm:pt-28">
      {/* ---------- LAYER 1 — deep space wash ---------- */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-30">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_18%_24%,rgba(168,85,247,0.13),transparent_52%),radial-gradient(ellipse_at_82%_70%,rgba(124,58,237,0.18),transparent_58%),radial-gradient(ellipse_at_50%_110%,rgba(76,29,149,0.22),transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:120px_120px]" />
      </div>

      {/* ---------- LAYER 2 — particle drift ---------- */}
      <Particles reduced={!!reduce} />

      {/* ---------- LAYER 3 — flowing market ribbons ---------- */}
      <MarketRibbons reduced={!!reduce} />

      {/* ---------- LAYER 4 — Onyx drone + Scout scan + goal orbs ---------- */}
      <IntelligenceStage reduced={!!reduce} scoutPortrait={scoutPortrait} />

      {/* ---------- LAYER 5 — bottom fade into next section ---------- */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-56 bg-gradient-to-b from-transparent to-[#07070b]"
      />

      {/* ---------- LAYER 6 — typography ---------- */}
      <div className="relative z-20 mx-auto flex min-h-[calc(100svh-6rem)] w-full max-w-7xl flex-col items-center justify-center px-5 pb-32 pt-8 text-center sm:px-8">
        <motion.p
          initial={reduce ? undefined : { opacity: 0, y: 8 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 1.2, delay: 0.2 }}
          className="font-mono text-[11px] uppercase tracking-[0.42em] text-purple-300/80"
        >
          <span className="mr-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-purple-400 align-middle shadow-[0_0_12px_rgba(168,85,247,0.9)]" />
          TurtleBot · live intelligence
        </motion.p>

        <motion.h1
          initial={reduce ? undefined : { opacity: 0, y: 24, filter: "blur(14px)" }}
          animate={reduce ? undefined : { opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 1.6, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="mt-6 max-w-[20ch] font-display text-[32px] font-semibold uppercase leading-[1.04] tracking-[-0.02em] text-white sm:text-[46px] md:text-[56px] lg:text-[64px]"
        >
          AI is changing{" "}
          <span className="text-white/45">the world.</span>
          <br />
          <span
            style={{
              background:
                "linear-gradient(90deg,#c084fc 0%,#a855f7 48%,#8b5cf6 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            TurtleBot puts it to work for you.
          </span>
        </motion.h1>

        <motion.p
          initial={reduce ? undefined : { opacity: 0, y: 12 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 1.2, delay: 1.4 }}
          className="mt-6 max-w-[46ch] text-[15px] leading-relaxed text-white/70 md:text-[17px]"
        >
          The same intelligence disrupting jobs, families and futures can be
          turned around — to protect your home, fund your dreams and build
          the life you were promised.
        </motion.p>

        <motion.div
          initial={reduce ? undefined : { opacity: 0, y: 12 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 1.9 }}
          className="mt-8 flex flex-wrap items-center justify-center gap-3"
        >
          <Link
            to="/welcome"
            className="landing-neo-button landing-neo-button-primary group inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-[13px] font-semibold tracking-[0.02em] text-white transition-transform hover:scale-[1.02]"
          >
            Build my Life Map
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <a
            href="#life-map"
            className="landing-neo-button inline-flex items-center rounded-full px-6 py-3.5 text-[13px] font-semibold tracking-[0.02em] text-white/85 backdrop-blur"
          >
            See it working
          </a>
        </motion.div>

        <motion.div
          initial={reduce ? undefined : { opacity: 0 }}
          animate={reduce ? undefined : { opacity: 1 }}
          transition={{ duration: 1, delay: 2.6 }}
          className="mx-auto mt-6 flex max-w-md flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[10.5px] uppercase tracking-[0.18em] text-white/45"
        >
          <span className="inline-flex items-center gap-2">
            <Lock className="h-3.5 w-3.5" /> Non-custodial
          </span>
          <span className="inline-flex items-center gap-2">
            <Activity className="h-3.5 w-3.5" /> Live in paper
          </span>
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5" /> Owner guardrails
          </span>
        </motion.div>

        <motion.div
          initial={reduce ? undefined : { opacity: 0 }}
          animate={reduce ? undefined : { opacity: 1 }}
          transition={{ duration: 1.4, delay: 3 }}
          className="pointer-events-none absolute inset-x-0 bottom-8 flex items-center justify-center gap-3 text-white/35"
        >
          <span className="h-px w-8 bg-white/20" />
          <span className="font-mono text-[10px] uppercase tracking-[0.36em]">
            Scroll to enter
          </span>
          <span className="h-px w-8 bg-white/20" />
        </motion.div>
      </div>
    </section>
  );
}

/* ---------------- Particles ---------------- */

function Particles({ reduced }: { reduced: boolean }) {
  const dots = useMemo(
    () =>
      Array.from({ length: reduced ? 0 : 60 }).map(() => ({
        x: Math.random() * 100,
        y: Math.random() * 100,
        s: 0.5 + Math.random() * 1.6,
        d: 6 + Math.random() * 14,
        delay: -Math.random() * 10,
        hue: Math.random() > 0.5 ? "#22d3ee" : "#a78bfa",
      })),
    [reduced],
  );
  if (reduced) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-20">
      {dots.map((p, i) => (
        <span
          key={i}
          className="absolute rounded-full"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.s,
            height: p.s,
            background: p.hue,
            boxShadow: `0 0 ${6 + p.s * 3}px ${p.hue}`,
            animation: `heroDrift ${p.d}s linear ${p.delay}s infinite`,
            opacity: 0.55,
          }}
        />
      ))}
      <style>{`
        @keyframes heroDrift {
          0% { transform: translate3d(0,0,0); opacity: 0; }
          15% { opacity: 0.7; }
          100% { transform: translate3d(-40px,-120px,0); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

/* ---------------- Market Ribbons ----------------
 * Flowing SVG chart lines that scroll across the width, layered at
 * different depths to give parallax. Not real market data — this is a
 * cinematic backdrop, not a chart.
 */
function MarketRibbons({ reduced }: { reduced: boolean }) {
  const ribbons = useMemo(
    () => [
      { top: "6%", stroke: "#22d3ee", opacity: 0.22, dur: 32, amp: 18, seed: 1 },
      { top: "88%", stroke: "#60a5fa", opacity: 0.18, dur: 44, amp: 32, seed: 2 },
      { top: "72%", stroke: "#a78bfa", opacity: 0.20, dur: 38, amp: 26, seed: 3 },
      { top: "82%", stroke: "#22d3ee", opacity: 0.12, dur: 52, amp: 40, seed: 4 },
    ],
    [],
  );
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {ribbons.map((r, i) => (
        <div
          key={i}
          className="absolute left-0 h-[220px] w-[220%]"
          style={{
            top: r.top,
            transform: "translateX(0)",
            animation: reduced
              ? undefined
              : `heroSlide ${r.dur}s linear infinite`,
          }}
        >
          <RibbonSvg stroke={r.stroke} opacity={r.opacity} amp={r.amp} seed={r.seed} />
        </div>
      ))}
      <style>{`
        @keyframes heroSlide {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}

function RibbonSvg({
  stroke,
  opacity,
  amp,
  seed,
}: {
  stroke: string;
  opacity: number;
  amp: number;
  seed: number;
}) {
  // Deterministic pseudo-random walk so the ribbon repeats seamlessly.
  const path = useMemo(() => {
    const W = 2400;
    const H = 220;
    const mid = H / 2;
    const points: string[] = [];
    let y = mid;
    let s = seed * 1.37;
    const step = 40;
    for (let x = 0; x <= W; x += step) {
      s = Math.sin(s * 12.9898) * 43758.5453;
      const r = s - Math.floor(s);
      y += (r - 0.5) * amp;
      y = Math.max(mid - amp * 2, Math.min(mid + amp * 2, y));
      points.push(`${x},${y.toFixed(1)}`);
    }
    // Duplicate for seamless loop.
    const half = points.slice();
    for (let i = 1; i < half.length; i++) {
      const [, yy] = half[i].split(",");
      points.push(`${Number(half[i].split(",")[0]) + W},${yy}`);
    }
    return `M ${points.join(" L ")}`;
  }, [amp, seed]);

  return (
    <svg viewBox="0 0 4800 220" preserveAspectRatio="none" className="h-full w-full">
      <defs>
        <linearGradient id={`rib-${seed}`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor={stroke} stopOpacity="0" />
          <stop offset="0.15" stopColor={stroke} stopOpacity={opacity} />
          <stop offset="0.85" stopColor={stroke} stopOpacity={opacity} />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`rib-fill-${seed}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity={opacity * 0.5} />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L 4800,220 L 0,220 Z`} fill={`url(#rib-fill-${seed})`} />
      <path d={path} fill="none" stroke={`url(#rib-${seed})`} strokeWidth={1.4} />
    </svg>
  );
}

/* ---------------- Intelligence Stage ---------------- */
/**
 * The mid-ground scene: Onyx drone floats above, sending signal beams
 * down to a row of Life-Map goal orbs. Scout scans the horizon on the
 * left. Every element is positioned in vh/vw so it composes with the
 * text without covering it.
 */
function IntelligenceStage({
  reduced,
  scoutPortrait,
}: {
  reduced: boolean;
  scoutPortrait: string;
}) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[5]">
      {/* Onyx drone — top right */}
      <OnyxDrone reduced={reduced} />

      {/* Scout — bottom left, scanning */}
      <ScoutScanner reduced={reduced} portrait={scoutPortrait} />

      {/* Goal orbs — bottom band, receiving funding */}
      <GoalOrbs reduced={reduced} />

      {/* Funds widget — bottom right, demonstration data */}
      <FundsWidget reduced={reduced} />
    </div>
  );
}

/* ---------------- Funds Widget ----------------
 * Small premium glass card. Shows available funds counting up, then
 * allocates -$125 to Emergency Fund and updates the balance. Loops.
 * Clearly labeled DEMONSTRATION DATA — no real numbers.
 */
function FundsWidget({ reduced }: { reduced: boolean }) {
  const START = 1883.95;
  const ALLOC = 125;
  const [balance, setBalance] = useState(START);
  const [wallet, setWallet] = useState(968.31);
  const [allocating, setAllocating] = useState(false);
  const [emergencyPct, setEmergencyPct] = useState(42);

  // Count-up on mount
  useEffect(() => {
    if (reduced) {
      setBalance(START);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = 0;
    const to = START;
    const dur = 1600;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setBalance(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  // Allocation loop
  useEffect(() => {
    if (reduced) return;
    let alive = true;
    const loop = async () => {
      while (alive) {
        await new Promise((r) => setTimeout(r, 3400));
        if (!alive) return;
        setAllocating(true);
        // ease balance down and wallet down
        const stepMs = 22;
        const steps = 28;
        for (let i = 1; i <= steps; i++) {
          if (!alive) return;
          const frac = i / steps;
          setBalance(START - ALLOC * frac);
          setWallet(968.31 - ALLOC * frac);
          setEmergencyPct(42 + 4 * frac);
          await new Promise((r) => setTimeout(r, stepMs));
        }
        await new Promise((r) => setTimeout(r, 1800));
        if (!alive) return;
        setAllocating(false);
        // reset
        for (let i = 1; i <= 20; i++) {
          if (!alive) return;
          const frac = i / 20;
          setBalance(START - ALLOC + ALLOC * frac);
          setWallet(968.31 - ALLOC + ALLOC * frac);
          setEmergencyPct(46 - 4 * frac);
          await new Promise((r) => setTimeout(r, 30));
        }
      }
    };
    loop();
    return () => {
      alive = false;
    };
  }, [reduced]);

  const fmt = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <motion.div
      initial={reduced ? undefined : { opacity: 0, y: 16 }}
      animate={reduced ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 1.2, delay: 1.6 }}
      className="pointer-events-none absolute right-4 bottom-[6%] hidden w-[250px] lg:block xl:right-8"
    >
      <div
        className="relative overflow-hidden rounded-2xl border border-white/10 p-4 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] backdrop-blur-xl"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%)",
        }}
      >
        <div className="flex items-center justify-between">
          <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-white/50">
            Available funds
          </p>
          <span className="rounded-full border border-cyan-300/30 px-1.5 py-[2px] font-mono text-[8px] uppercase tracking-[0.18em] text-cyan-300/80">
            Demo
          </span>
        </div>
        <p className="mt-1.5 font-display text-[26px] font-semibold tabular-nums leading-none tracking-tight text-white">
          ${fmt(balance)}
        </p>

        <div className="mt-3 space-y-1.5 text-[12px]">
          <Row label="Wallet" value={`$${fmt(wallet)}`} />
          <Row label="Trading" value="$462.36" />
          <Row label="Rewards" value="$453.28" />
        </div>

        <div className="mt-3 rounded-lg border border-white/[0.06] bg-black/30 p-2.5">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/50">
              Emergency Fund
            </p>
            <span
              className={`font-mono text-[10px] tabular-nums transition-colors ${
                allocating ? "text-emerald-300" : "text-white/50"
              }`}
            >
              {allocating ? "-$125.00" : `${Math.round(emergencyPct)}%`}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${emergencyPct}%`,
                background:
                  "linear-gradient(90deg,#22d3ee 0%,#60a5fa 60%,#a78bfa 100%)",
                boxShadow: "0 0 10px rgba(34,211,238,0.5)",
              }}
            />
          </div>
        </div>

        <p className="mt-2 font-mono text-[8.5px] uppercase tracking-[0.22em] text-white/30">
          Demonstration data
        </p>
      </div>
    </motion.div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/55">{label}</span>
      <span className="font-mono tabular-nums text-white/85">{value}</span>
    </div>
  );
}

function OnyxDrone({ reduced }: { reduced: boolean }) {
  return (
    <motion.div
      initial={reduced ? undefined : { opacity: 0, y: -20 }}
      animate={reduced ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 1.6, delay: 1 }}
      className="absolute right-[6%] top-[18%] hidden md:block"
      style={{
        animation: reduced ? undefined : "onyxFloat 6s ease-in-out infinite",
      }}
    >
      <svg width="150" height="150" viewBox="0 0 150 150">
        <defs>
          <radialGradient id="onyxCore" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="35%" stopColor="#a78bfa" stopOpacity="0.9" />
            <stop offset="70%" stopColor="#3b0764" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#0b0416" stopOpacity="1" />
          </radialGradient>
          <radialGradient id="onyxHalo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* soft halo */}
        <circle cx="75" cy="75" r="72" fill="url(#onyxHalo)" />

        {/* outer rotating ring */}
        <g style={{ transformOrigin: "75px 75px", animation: reduced ? undefined : "onyxSpin 22s linear infinite" }}>
          <circle cx="75" cy="75" r="56" fill="none" stroke="#a78bfa" strokeOpacity="0.35" strokeWidth="0.8" strokeDasharray="2 6" />
          <circle cx="75" cy="75" r="56" fill="none" stroke="#22d3ee" strokeOpacity="0.5" strokeWidth="1.2" strokeDasharray="18 340" />
        </g>
        {/* inner counter-rotating ring */}
        <g style={{ transformOrigin: "75px 75px", animation: reduced ? undefined : "onyxSpinRev 14s linear infinite" }}>
          <circle cx="75" cy="75" r="42" fill="none" stroke="#c4b5fd" strokeOpacity="0.4" strokeWidth="0.6" strokeDasharray="1 4" />
        </g>
        {/* core */}
        <circle cx="75" cy="75" r="26" fill="url(#onyxCore)" />
        <circle cx="75" cy="75" r="26" fill="none" stroke="#e9d5ff" strokeOpacity="0.5" strokeWidth="0.6" />
        {/* pulsing pupil */}
        <circle cx="75" cy="75" r="6" fill="#fff" style={{ animation: reduced ? undefined : "onyxPulse 2.6s ease-in-out infinite" }} />
      </svg>
      <div className="mt-3 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-violet-300/80">
          Onyx
        </p>
        <p className="mt-1 text-[10px] text-white/45">deciding</p>
      </div>

      <style>{`
        @keyframes onyxFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-14px); } }
        @keyframes onyxSpin { to { transform: rotate(360deg); } }
        @keyframes onyxSpinRev { to { transform: rotate(-360deg); } }
        @keyframes onyxPulse { 0%,100% { opacity: 1; r: 6; } 50% { opacity: 0.4; } }
      `}</style>
    </motion.div>
  );
}

function ScoutScanner({ reduced, portrait }: { reduced: boolean; portrait: string }) {
  return (
    <motion.div
      initial={reduced ? undefined : { opacity: 0, x: -20 }}
      animate={reduced ? undefined : { opacity: 1, x: 0 }}
      transition={{ duration: 1.4, delay: 1.2 }}
      className="absolute left-[4%] top-[22%] hidden lg:block"
    >
      <div className="relative h-[140px] w-[140px]">
        {/* scan sweep */}
        {!reduced && (
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "conic-gradient(from 0deg, rgba(34,211,238,0) 0deg, rgba(34,211,238,0.55) 30deg, rgba(34,211,238,0) 60deg, rgba(34,211,238,0) 360deg)",
              animation: "scoutSweep 4s linear infinite",
              maskImage: "radial-gradient(circle, black 55%, transparent 72%)",
              WebkitMaskImage: "radial-gradient(circle, black 55%, transparent 72%)",
            }}
          />
        )}
        {/* rings */}
        <div className="absolute inset-2 rounded-full border border-cyan-400/25" />
        <div className="absolute inset-5 rounded-full border border-cyan-400/20" />
        <div className="absolute inset-8 rounded-full border border-cyan-400/15" />
        {/* portrait */}
        <div className="absolute inset-[22%] overflow-hidden rounded-full border border-cyan-400/50 shadow-[0_0_30px_rgba(34,211,238,0.35)]">
          <img src={portrait} alt="" className="h-full w-full object-cover" />
        </div>
      </div>
      <div className="mt-3 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-cyan-300/80">
          Scout
        </p>
        <p className="mt-1 text-[10px] text-white/45">scanning BTC · XRP · SOL · ETH</p>
      </div>
      <style>{`
        @keyframes scoutSweep { to { transform: rotate(360deg); } }
      `}</style>
    </motion.div>
  );
}

/* Goal orbs — small pill-glyphs across the bottom band. Funding beams
 * periodically travel from top (Onyx) toward them.
 */
const GOALS = [
  { label: "Rent", hue: "#22d3ee" },
  { label: "Emergency", hue: "#60a5fa" },
  { label: "Kids", hue: "#a78bfa" },
  { label: "Home", hue: "#22d3ee" },
  { label: "Freedom", hue: "#f0abfc" },
];

function GoalOrbs({ reduced }: { reduced: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1800);
    return () => window.clearInterval(id);
  }, [reduced]);

  const activeIdx = tick % GOALS.length;
  const beamRef = useRef<HTMLDivElement>(null);

  return (
    <div className="absolute inset-x-0 bottom-[6%] hidden justify-center gap-6 md:flex lg:gap-10">
      {GOALS.map((g, i) => {
        const active = i === activeIdx;
        return (
          <div key={g.label} className="relative flex flex-col items-center">
            {/* incoming beam from top when active */}
            {active && !reduced && (
              <div
                ref={beamRef}
                className="absolute -top-[38vh] left-1/2 h-[38vh] w-px -translate-x-1/2 origin-top"
                style={{
                  background: `linear-gradient(180deg, transparent 0%, ${g.hue}66 30%, ${g.hue} 100%)`,
                  animation: "beamDrop 1.6s ease-out forwards",
                  opacity: 0,
                }}
              />
            )}
            <div
              className="relative h-11 w-11 rounded-full border transition-all"
              style={{
                borderColor: active ? g.hue : "rgba(255,255,255,0.15)",
                background: active
                  ? `radial-gradient(circle, ${g.hue}55 0%, transparent 70%)`
                  : "rgba(255,255,255,0.03)",
                boxShadow: active ? `0 0 24px ${g.hue}88` : undefined,
              }}
            >
              <div
                className="absolute inset-[30%] rounded-full"
                style={{
                  background: active ? g.hue : "rgba(255,255,255,0.35)",
                  boxShadow: active ? `0 0 12px ${g.hue}` : undefined,
                }}
              />
            </div>
            <p
              className="mt-2 font-mono text-[9px] uppercase tracking-[0.24em] transition-colors"
              style={{ color: active ? "#fff" : "rgba(255,255,255,0.4)" }}
            >
              {g.label}
            </p>
          </div>
        );
      })}
      <style>{`
        @keyframes beamDrop {
          0% { transform: translateX(-50%) scaleY(0); opacity: 0; }
          40% { opacity: 1; }
          100% { transform: translateX(-50%) scaleY(1); opacity: 0.9; }
        }
      `}</style>
    </div>
  );
}
