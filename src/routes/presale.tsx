import { createFileRoute } from "@tanstack/react-router";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import {
  GlassCard,
  GradientText,
  SectionHeading,
  SectionShell,
  StatusPill,
} from "@/components/marketing/primitives";
import { WaitlistForm } from "@/components/marketing/WaitlistForm";

const CANONICAL = "https://turtle-trade-guard.lovable.app/presale";
const TITLE = "TurtleBot Presale — Register your interest";
const DESC =
  "Join the TurtleBot presale waitlist. Registration is not an allocation and not an offer of securities — mechanics will be published in advance.";

export const Route = createFileRoute("/presale")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:url", content: CANONICAL },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: CANONICAL }],
  }),
  component: PresalePage,
});

function PresalePage() {
  return (
    <MarketingShell>
      <SectionShell className="pt-14 sm:pt-20">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
          <div className="space-y-6">
            <StatusPill accent="violet">Waitlist open · No allocation guaranteed</StatusPill>
            <SectionHeading
              align="left"
              eyebrow="Presale"
              title={
                <>
                  Register early <GradientText>and honestly.</GradientText>
                </>
              }
              subtitle="TurtleBot plans to launch a utility token approximately 12 months from public launch, subject to jurisdictional and compliance review. Waitlist registration does not create an allocation, an offer, or a purchase right — it lets you receive the mechanics first when they are published."
            />
            <ul className="space-y-3 text-sm text-white/75">
              <li className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-cyan-300/90">
                  What waitlist means
                </p>
                <p className="mt-1">
                  You'll receive the token utility summary, distribution framework, eligibility
                  criteria, and timing — before any public announcement.
                </p>
              </li>
              <li className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-cyan-300/90">
                  What waitlist is not
                </p>
                <p className="mt-1">
                  Not an offer to sell securities. Not a guarantee of allocation. Not a promise of
                  price or return. Not eligible in every jurisdiction.
                </p>
              </li>
              <li className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-cyan-300/90">Compliance</p>
                <p className="mt-1">
                  Any distribution will be subject to KYC/AML, sanctions screening, and
                  region-specific eligibility. Full terms will be published in advance.
                </p>
              </li>
            </ul>
          </div>
          <GlassCard glow>
            <p className="font-display text-xl font-semibold text-white">Join the waitlist</p>
            <p className="mt-1 text-sm text-white/60">
              We'll email you when the token utility summary and distribution framework are
              published.
            </p>
            <div className="mt-5">
              <WaitlistForm kind="presale" source="presale" ctaLabel="Join waitlist" />
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <MiniStat label="Target window" value="~12 months out" />
              <MiniStat label="Structure" value="Utility · Subject to review" />
            </div>
          </GlassCard>
        </div>
      </SectionShell>
    </MarketingShell>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="text-[10px] uppercase tracking-[0.2em] text-white/50">{label}</p>
      <p className="mt-1 font-display text-sm font-semibold text-white">{value}</p>
    </div>
  );
}
