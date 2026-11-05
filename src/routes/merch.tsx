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
import { brand } from "@/lib/marketing/data";

const CANONICAL = "https://turtle-trade-guard.lovable.app/merch";
const TITLE = "TurtleBot Merch — Preview & waitlist";
const DESC =
  "Preview the upcoming TurtleBot merch line — apparel, accessories, and collector items designed for the Turtle Collective community.";

export const Route = createFileRoute("/merch")({
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
  component: MerchPage,
});

const CATEGORIES = [
  {
    key: "apparel",
    title: "Apparel",
    body: "Turtle Collective tees, hoodies, and outerwear built around the character system.",
    accent: "cyan" as const,
  },
  {
    key: "accessories",
    title: "Accessories",
    body: "Caps, patches, pins and desk items with a considered design language.",
    accent: "violet" as const,
  },
  {
    key: "collector",
    title: "Collector items",
    body: "Numbered artifacts tied to ecosystem milestones and character debuts.",
    accent: "gold" as const,
  },
];

function MerchPage() {
  return (
    <MarketingShell>
      <SectionShell className="pt-14 sm:pt-20">
        <SectionHeading
          eyebrow="Merch"
          title={
            <>
              Wear the <GradientText>Collective.</GradientText>
            </>
          }
          subtitle="A considered merch line for the TurtleBot community. Timing and pricing are not yet confirmed — join the waitlist for first access."
        />

        <div className="mt-12 grid gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div className="relative">
            <div className="absolute -inset-8 rounded-[3rem] bg-gradient-to-tr from-amber-400/15 via-transparent to-cyan-400/15 blur-3xl" />
            <div className="relative overflow-hidden rounded-[2.5rem] border border-white/10 bg-white/[0.02] p-2 backdrop-blur-xl">
              <img
                src={brand.tradeHero}
                alt="TurtleBot merch mood board"
                className="w-full rounded-[2rem] object-cover"
                loading="lazy"
                decoding="async"
              />
            </div>
          </div>
          <GlassCard glow>
            <StatusPill accent="amber">Coming soon</StatusPill>
            <p className="mt-4 font-display text-xl font-semibold text-white">
              Get first access
            </p>
            <p className="mt-1 text-sm text-white/60">
              Early waitlist members receive first look at the drop, price, and any limited-run
              inventory.
            </p>
            <div className="mt-5">
              <WaitlistForm kind="merch" source="merch" ctaLabel="Notify me" />
            </div>
          </GlassCard>
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-3">
          {CATEGORIES.map((c) => (
            <GlassCard key={c.key}>
              <StatusPill accent={c.accent}>Preview</StatusPill>
              <h3 className="mt-3 font-display text-lg font-semibold text-white">{c.title}</h3>
              <p className="mt-2 text-sm text-white/65">{c.body}</p>
            </GlassCard>
          ))}
        </div>
      </SectionShell>
    </MarketingShell>
  );
}
