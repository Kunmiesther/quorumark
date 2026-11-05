import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { brand } from "@/lib/marketing/data";
import { ParticleField } from "./ParticleField";
import { GradientText, StatusPill } from "./primitives";

export function HeroSection() {
  return (
    <section className="relative isolate overflow-hidden pt-16 sm:pt-24">
      <ParticleField density={80} />
      <div className="relative mx-auto grid w-full max-w-7xl gap-10 px-4 pb-24 pt-10 sm:px-6 md:grid-cols-[1.05fr_0.95fr] md:items-center lg:px-8">
        <div className="space-y-7">
          <StatusPill accent="cyan">Paper trading live · Live testing internal</StatusPill>
          <h1 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl md:text-6xl">
            AI is changing <span className="text-white/60">how people work.</span>
            <br />
            <GradientText>TurtleBot</GradientText> is changing{" "}
            <span className="text-white/60">who AI works for.</span>
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-white/75">
            A non-custodial trading platform coordinated by Onyx — the intelligence layer that
            weighs every signal before capital moves. Built for everyday people. Powerful enough
            for traders.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              to="/home"
              className="group inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 px-6 py-3 text-sm font-semibold text-black transition-transform hover:scale-[1.03]"
            >
              Enter TurtleBot
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              to="/whitepaper"
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.03] px-6 py-3 text-sm font-medium text-white/85 backdrop-blur transition-colors hover:bg-white/[0.06]"
            >
              Read the whitepaper
            </Link>
          </div>
          <dl className="grid grid-cols-3 gap-4 pt-6 text-left">
            <HeroStat label="Non-custodial" value="Trade only" hint="We never withdraw" />
            <HeroStat label="Coverage" value="4" hint="BTC · XRP · SOL · ETH" />
            <HeroStat label="Cadence" value="Every minute" hint="Scout → Onyx → Vanguard" />
          </dl>
        </div>
        <div className="relative">
          <div className="absolute -inset-8 rounded-[3rem] bg-gradient-to-tr from-violet-500/25 via-transparent to-cyan-400/25 blur-3xl" />
          <div className="relative overflow-hidden rounded-[2.5rem] border border-white/10 bg-white/[0.03] p-2 backdrop-blur-xl">
            <img
              src={brand.homeHero}
              alt="TurtleBot hero visualization"
              className="w-full rounded-[2rem] object-cover"
              loading="eager"
              decoding="async"
            />
          </div>
          <div className="absolute -bottom-4 left-6 hidden rounded-2xl border border-white/10 bg-black/70 px-4 py-3 backdrop-blur-xl md:flex md:items-center md:gap-3">
            <img
              src={brand.onyxHead}
              alt=""
              className="h-9 w-9 rounded-full border border-violet-400/40 object-cover"
            />
            <div>
              <p className="text-xs font-semibold text-white">Onyx · Intelligence Commander</p>
              <p className="text-[11px] text-white/60">Decides. Records. Explains.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 backdrop-blur">
      <dt className="text-[10px] uppercase tracking-[0.2em] text-white/50">{label}</dt>
      <dd className="mt-1 font-display text-xl font-semibold text-white">{value}</dd>
      <p className="text-[11px] text-white/50">{hint}</p>
    </div>
  );
}
