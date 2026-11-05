import { ecosystemNodes } from "@/lib/marketing/data";
import { GlassCard, SectionHeading, SectionShell, StatusPill } from "./primitives";

const accent: Record<string, "emerald" | "amber" | "muted"> = {
  Live: "emerald",
  "In development": "amber",
  Planned: "muted",
};

export function EcosystemSection() {
  return (
    <SectionShell id="ecosystem">
      <SectionHeading
        eyebrow="The Ecosystem"
        title="One coherent system, not a bundle of apps."
        subtitle="Every layer serves the same purpose: helping everyday people benefit from AI-powered markets, with dignity, safety, and transparency."
      />
      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ecosystemNodes.map((n) => (
          <GlassCard key={n.key} className="flex flex-col gap-3">
            <StatusPill accent={accent[n.status] ?? "muted"}>{n.status}</StatusPill>
            <p className="font-display text-lg font-semibold text-white">{n.label}</p>
            <p className="text-sm leading-relaxed text-white/65">{n.description}</p>
          </GlassCard>
        ))}
      </div>
    </SectionShell>
  );
}
