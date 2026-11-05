import { roadmapPhases } from "@/lib/marketing/data";
import { SectionHeading, SectionShell, StatusPill } from "./primitives";

const accent: Record<string, "emerald" | "cyan" | "violet" | "amber" | "muted"> = {
  Complete: "emerald",
  "In progress": "cyan",
  Next: "violet",
  Planned: "muted",
  Target: "amber",
};

/**
 * Compact horizontal rail — 4 cards on desktop, horizontal scroll on mobile.
 * Site language: pure black, thin borders, violet accent on hover.
 */
export function RoadmapTimeline({ compact: _compact = false }: { compact?: boolean }) {
  return (
    <SectionShell id="roadmap">
      <SectionHeading
        eyebrow="Roadmap"
        title="A phased build — not a promise machine."
        subtitle="Every stage carries an honest status. Nothing marked Planned or Target is a guarantee; every capability is subject to security, reliability and compliance review before it goes live."
      />
      <ol className="relative mt-10 grid grid-flow-col auto-cols-[80%] gap-3 overflow-x-auto pb-3 sm:auto-cols-[46%] md:auto-cols-[26%] lg:grid-flow-row lg:grid-cols-4 lg:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {roadmapPhases.map((p) => {
          const dotClass =
            p.status === "Complete"
              ? "bg-emerald-400"
              : p.status === "In progress"
                ? "bg-cyan-300"
                : "bg-white/30";
          return (
            <li
              key={p.phase}
              className="group relative flex h-full flex-col rounded-xl border border-white/[0.08] bg-black p-4 transition-colors hover:border-[color:var(--accent)]/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.24em] text-white/50">
                  {p.phase}
                </span>
                <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
              </div>
              <p className="mt-3 font-display text-[15px] font-semibold leading-tight text-white">
                {p.title}
              </p>
              <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/40">
                {p.window}
              </p>
              <ul className="mt-3 space-y-1 text-[11.5px] leading-snug text-white/60">
                {p.bullets.slice(0, 2).map((b) => (
                  <li key={b} className="flex gap-1.5">
                    <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-white/40" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-3">
                <StatusPill accent={accent[p.status] ?? "muted"}>{p.status}</StatusPill>
              </div>
            </li>
          );
        })}
      </ol>
    </SectionShell>
  );
}
