import { Link } from "@tanstack/react-router";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { brand, brandLines } from "@/lib/marketing/data";
import { GlassCard, GradientText, SectionHeading, SectionShell } from "./primitives";

export function ManifestoSection() {
  return (
    <SectionShell id="manifesto">
      <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <div className="space-y-6">
          <SectionHeading
            align="left"
            eyebrow="Manifesto"
            title={
              <>
                <GradientText>{brandLines.purpose}</GradientText>
              </>
            }
            subtitle={brandLines.thrive}
          />
          <p className="text-base leading-relaxed text-white/70">
            The people who most need AI-powered financial tools are the least likely to build
            them. TurtleBot is our answer: a safe, transparent, non-custodial trading platform
            that anyone can understand — and that a professional would still respect.
          </p>
          <ul className="grid gap-3 sm:grid-cols-2">
            <ValueRow label="Never custody" body="We can trade in your connected account. We can never withdraw." />
            <ValueRow label="Onyx-audited" body="Every decision — entry, hold, exit — is recorded with rationale." />
            <ValueRow label="Human override" body="Pause, kill switch, and manual control are available at every layer." />
            <ValueRow label="Everyday-first" body="Plain-language explanations for every screen and every action." />
          </ul>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link
              to="/whitepaper"
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.03] px-5 py-2.5 text-sm text-white/85 backdrop-blur hover:bg-white/[0.06]"
            >
              Read the full whitepaper
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/roadmap"
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.03] px-5 py-2.5 text-sm text-white/85 backdrop-blur hover:bg-white/[0.06]"
            >
              See the roadmap
            </Link>
          </div>
        </div>
        <div className="relative">
          <div className="absolute -inset-6 rounded-[3rem] bg-gradient-to-tr from-cyan-400/20 via-transparent to-violet-500/25 blur-3xl" />
          <GlassCard glow className="relative">
            <div className="flex items-center gap-3">
              <img
                src={brand.redLava}
                alt=""
                className="h-16 w-16 rounded-2xl border border-white/10 object-cover"
              />
              <div>
                <p className="font-display text-lg font-semibold text-white">
                  Built for everyday people.
                </p>
                <p className="text-sm text-white/60">Powerful enough for traders.</p>
              </div>
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <MiniStat label="Custody model" value="Non-custodial" />
              <MiniStat label="Withdraw rights" value="None" />
              <MiniStat label="Decision cadence" value="Every minute" />
              <MiniStat label="Audit trail" value="Per-decision" />
            </div>
            <div className="mt-6 flex items-start gap-2 rounded-2xl border border-cyan-400/20 bg-cyan-400/5 p-3 text-xs text-cyan-100/90">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
              <p>
                Every proposed action is preflighted by Warden — the risk layer — before Vanguard
                is allowed to send an order to your exchange.
              </p>
            </div>
          </GlassCard>
        </div>
      </div>
    </SectionShell>
  );
}

function ValueRow({ label, body }: { label: string; body: string }) {
  return (
    <li className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300/90">{label}</p>
      <p className="mt-1 text-sm text-white/70">{body}</p>
    </li>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <p className="text-[10px] uppercase tracking-[0.2em] text-white/50">{label}</p>
      <p className="mt-1 font-display text-sm font-semibold text-white">{value}</p>
    </div>
  );
}
