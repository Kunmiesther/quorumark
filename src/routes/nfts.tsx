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

const CANONICAL = "https://turtle-trade-guard.lovable.app/nfts";
const TITLE = "TurtleBot NFTs — Genesis & Evolution Collections";
const DESC =
  "Preview the planned TurtleBot NFT collections: Genesis character NFTs and Evolution Armor. Utility, identity, and access — no drop dates confirmed yet.";

export const Route = createFileRoute("/nfts")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:url", content: CANONICAL },
      { property: "og:type", content: "website" },
      { property: "og:image", content: `https://turtle-trade-guard.lovable.app${brand.collectible}` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: `https://turtle-trade-guard.lovable.app${brand.collectible}` },
    ],
    links: [{ rel: "canonical", href: CANONICAL }],
  }),
  component: NftsPage,
});

function NftsPage() {
  return (
    <MarketingShell>
      <SectionShell className="pt-14 sm:pt-20">
        <SectionHeading
          eyebrow="NFT Collections"
          title={
            <>
              Digital collectibles with <GradientText>real ecosystem utility.</GradientText>
            </>
          }
          subtitle="Two planned drops — Genesis and Evolution — designed to grant persistent access, identity, and progression across the TurtleBot ecosystem. Drop timing and mechanics will be published before any mint."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <GlassCard glow>
            <StatusPill accent="gold">Planned · Target 2027</StatusPill>
            <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/40">
              <img
                src={brand.collectible}
                alt="TurtleBot Genesis collectible preview"
                className="aspect-[4/3] w-full object-cover"
                loading="lazy"
                decoding="async"
              />
            </div>
            <h3 className="mt-5 font-display text-2xl font-semibold text-white">
              Genesis Turtles
            </h3>
            <p className="mt-2 text-sm text-white/70">
              A limited founding collection of character NFTs. Each grants persistent ecosystem
              access, identity across the Turtle Collective, and priority for future ecosystem
              programs.
            </p>
            <ul className="mt-4 space-y-1.5 text-sm text-white/70">
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300" />
                Founding-status identity across the app
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300" />
                Priority for future ecosystem programs
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300" />
                Foundation for Evolution Armor compatibility
              </li>
            </ul>
            <div className="mt-6">
              <WaitlistForm kind="nft_genesis" source="nfts" ctaLabel="Notify me · Genesis" />
            </div>
          </GlassCard>

          <GlassCard glow>
            <StatusPill accent="violet">Planned · Follows Genesis</StatusPill>
            <div
              className="mt-4 flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 30% 30%, rgba(153,69,255,0.18), transparent 55%)",
              }}
              aria-label="Evolution artwork placeholder"
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-white/40">
                NFTurtle artwork · coming soon
              </p>
            </div>
            <h3 className="mt-5 font-display text-2xl font-semibold text-white">
              Evolution
            </h3>
            <p className="mt-2 text-sm text-white/70">
              A modular add-on collection that extends Genesis utility with new roles, ranks and
              ecosystem programs.
            </p>
            <ul className="mt-4 space-y-1.5 text-sm text-white/70">
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" />
                Composable with Genesis identity
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" />
                Expanded roles & ecosystem privileges
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" />
                Deeper Life Map integration
              </li>
            </ul>
            <div className="mt-6">
              <WaitlistForm kind="nft_evolution" source="nfts" ctaLabel="Notify me · Evolution" />
            </div>
          </GlassCard>
        </div>

        <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-center text-xs text-white/55">
          Registering interest is not a mint, purchase, or allocation. Full mechanics, chain,
          supply, timing and eligibility will be published before any drop. Not eligible in every
          jurisdiction.
        </div>
      </SectionShell>
    </MarketingShell>
  );
}
