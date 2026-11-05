import { createFileRoute } from "@tanstack/react-router";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { RoadmapTimeline } from "@/components/marketing/RoadmapTimeline";
import { SectionShell, SectionHeading, GradientText } from "@/components/marketing/primitives";

const CANONICAL = "https://turtle-trade-guard.lovable.app/roadmap";
const TITLE = "TurtleBot Roadmap — From foundation to ecosystem";
const DESC =
  "The honest TurtleBot roadmap. Every phase is labeled Complete, In progress, Next, Planned or Target — never as a guarantee.";

export const Route = createFileRoute("/roadmap")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:url", content: CANONICAL },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: CANONICAL }],
  }),
  component: RoadmapPage,
});

function RoadmapPage() {
  return (
    <MarketingShell>
      <SectionShell className="pb-6 pt-14 sm:pt-20">
        <SectionHeading
          eyebrow="Roadmap"
          title={
            <>
              A phased build — <GradientText>not a promise machine.</GradientText>
            </>
          }
          subtitle="Every phase is labeled with its real status. Nothing marked Planned or Target is a guarantee — capability rolls out only after security, reliability and compliance review."
        />
      </SectionShell>
      <RoadmapTimeline />
    </MarketingShell>
  );
}
