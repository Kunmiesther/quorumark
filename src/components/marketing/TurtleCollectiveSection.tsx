import { turtleCollective } from "@/lib/marketing/data";
import { GlassCard, SectionShell, SectionHeading, StatusPill } from "./primitives";

const statusAccent: Record<string, "emerald" | "cyan" | "amber" | "muted"> = {
  Live: "emerald",
  "Live in paper": "cyan",
  "In development": "amber",
  Planned: "muted",
};

export function TurtleCollectiveSection() {
  return (
    <SectionShell id="turtles">
      <SectionHeading
        eyebrow="The Turtle Collective"
        title="Eight roles. One coordinated engine."
        subtitle="Each turtle owns a single responsibility. Together they form the intelligence, execution and safety layers of a single non-custodial trading system."
      />
      <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {turtleCollective.map((t) => (
          <GlassCard key={t.key} glow className="group flex flex-col gap-4">
            <div className="relative">
              <div className="absolute inset-0 -z-10 rounded-2xl bg-gradient-to-b from-white/[0.06] to-transparent blur-2xl" />
              <div className="mx-auto aspect-square w-32 overflow-hidden rounded-2xl border border-white/10 bg-black/40">
                <img
                  src={t.portrait}
                  alt={`${t.name} portrait`}
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  loading="lazy"
                  decoding="async"
                />
              </div>
            </div>
            <div className="text-center">
              <p className="font-display text-lg font-semibold text-white">{t.name}</p>
              <p className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-white/50">
                {t.role}
              </p>
            </div>
            <p className="text-center text-sm text-white/75">{t.tagline}</p>
            <p className="text-xs leading-relaxed text-white/55">{t.description}</p>
            <div className="mt-auto flex justify-center pt-2">
              <StatusPill accent={statusAccent[t.status] ?? "muted"}>{t.status}</StatusPill>
            </div>
          </GlassCard>
        ))}
      </div>
    </SectionShell>
  );
}
