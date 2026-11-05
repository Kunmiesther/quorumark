import { Link } from "@tanstack/react-router";
import { brand } from "@/lib/marketing/data";
import { GlassCard, GradientText, SectionHeading, SectionShell, StatusPill } from "./primitives";
import { WaitlistForm } from "./WaitlistForm";

export function CollectibleTeaserSection() {
  return (
    <SectionShell id="collectibles">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
        <div className="relative">
          <div className="absolute -inset-10 rounded-[3rem] bg-gradient-to-tr from-amber-400/15 via-transparent to-rose-400/20 blur-3xl" />
          <div className="relative overflow-hidden rounded-[2.5rem] border border-white/10 bg-white/[0.02] p-2 backdrop-blur-xl">
            <img
              src={brand.collectible}
              alt="TurtleBot Collectibles preview"
              className="w-full rounded-[2rem] object-cover"
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>
        <div className="space-y-6">
          <StatusPill accent="gold">Target 2027 · Planned</StatusPill>
          <SectionHeading
            align="left"
            eyebrow="Collectibles"
            title={
              <>
                <GradientText>Turtles</GradientText> that carry meaning, not hype.
              </>
            }
            subtitle="Genesis and Evolution collections will unlock ecosystem utility — access, identity, and progression. Join the waitlist to receive drop mechanics, timing, and eligibility criteria before anyone else."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <GlassCard>
              <p className="font-display text-sm font-semibold text-white">Genesis</p>
              <p className="mt-1 text-xs text-white/60">
                Founding character NFTs granting persistent ecosystem access.
              </p>
            </GlassCard>
            <GlassCard>
              <p className="font-display text-sm font-semibold text-white">Evolution Armor</p>
              <p className="mt-1 text-xs text-white/60">
                Modular add-on collection extending Genesis utility.
              </p>
            </GlassCard>
          </div>
          <div className="pt-2">
            <WaitlistForm kind="nft_genesis" source="home" ctaLabel="Notify me" />
          </div>
          <p className="text-xs text-white/40">
            Joining the waitlist is not an allocation. Full mechanics will be published before any
            drop.{" "}
            <Link to="/nfts" className="text-cyan-300 hover:underline">
              See collection details →
            </Link>
          </p>
        </div>
      </div>
    </SectionShell>
  );
}
