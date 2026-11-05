import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { GradientText, SectionShell } from "./primitives";
import { ParticleField } from "./ParticleField";

export function ClosingCta() {
  return (
    <SectionShell id="cta">
      <div className="relative overflow-hidden rounded-[2.5rem] border border-white/10 bg-gradient-to-br from-violet-500/20 via-black/40 to-cyan-400/20 p-10 sm:p-16">
        <ParticleField density={40} />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <h2 className="font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
            The market is loud. <GradientText>Onyx is quiet.</GradientText>
          </h2>
          <p className="mt-4 text-base text-white/75 sm:text-lg">
            Connect an exchange, pick a strategy, and let the collective work — with full
            visibility, full control, and zero custody.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              to="/home"
              className="group inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 px-6 py-3 text-sm font-semibold text-black transition-transform hover:scale-[1.03]"
            >
              Enter TurtleBot
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              to="/presale"
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.03] px-6 py-3 text-sm text-white/85 backdrop-blur hover:bg-white/[0.06]"
            >
              Join the presale waitlist
            </Link>
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
