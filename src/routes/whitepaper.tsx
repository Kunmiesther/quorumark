import { createFileRoute, Link } from "@tanstack/react-router";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import {
  GlassCard,
  GradientText,
  SectionHeading,
  SectionShell,
  StatusPill,
} from "@/components/marketing/primitives";
import { brand, brandLines } from "@/lib/marketing/data";

const CANONICAL = "https://turtle-trade-guard.lovable.app/whitepaper";
const TITLE = "TurtleBot Whitepaper — Onyx, the Collective, and the Ecosystem";
const DESC =
  "Read how TurtleBot works: the non-custodial trading model, the Onyx intelligence layer, the eight-turtle collective, safety posture and roadmap.";

export const Route = createFileRoute("/whitepaper")({
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
  component: WhitepaperPage,
});

const SECTIONS = [
  { id: "vision", label: "Vision" },
  { id: "principles", label: "Principles" },
  { id: "architecture", label: "Architecture" },
  { id: "safety", label: "Safety" },
  { id: "economics", label: "Economics" },
  { id: "governance", label: "Governance" },
  { id: "risks", label: "Risks & disclosures" },
];

function WhitepaperPage() {
  return (
    <MarketingShell>
      <SectionShell className="pb-10 pt-14 sm:pt-20">
        <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
          <aside className="lg:sticky lg:top-24 lg:h-max">
            <GlassCard className="p-4">
              <p className="type-eyebrow text-cyan-300/80">Whitepaper</p>
              <p className="mt-1 type-display-md text-white">v0.9 · Draft</p>
              <StatusPill accent="cyan" className="mt-3">
                Living document
              </StatusPill>
              <nav className="mt-5 space-y-1 type-body-sm">
                {SECTIONS.map((s) => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    className="block rounded-lg px-2 py-1.5 text-white/70 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    {s.label}
                  </a>
                ))}
              </nav>
            </GlassCard>
          </aside>

          <article className="space-y-10">
            <header className="space-y-4">
              <StatusPill accent="violet">Foundational document</StatusPill>
              <h1 className="type-display-hero text-white">
                The TurtleBot <GradientText>Whitepaper</GradientText>
              </h1>
              <p className="type-body-lg text-white/75">{brandLines.thrive}</p>
            </header>

            <Section id="vision" title="1 · Vision">
              <p>
                TurtleBot exists to change <em>who</em> AI works for. Modern automated trading has
                been available to institutions for a decade. The intelligence gap between
                professionals and everyday people has widened, not closed. TurtleBot is designed
                to close it — safely, transparently, and without ever taking custody of user
                funds.
              </p>
              <p>
                We are not building a bot that talks like a human. We are building a system that
                behaves with the discipline of a professional trading desk, expressed in language
                a non-technical person can understand.
              </p>
            </Section>

            <Section id="principles" title="2 · Principles">
              <ul className="grid gap-3 sm:grid-cols-2">
                <PrincipleCard title="Never custody">
                  TurtleBot trades in your exchange account under explicit permissions. Withdraw
                  permission is never requested and never used.
                </PrincipleCard>
                <PrincipleCard title="Explain every decision">
                  Onyx records the rationale for every entry, hold, and exit. The trail is
                  browsable, not marketing-copy.
                </PrincipleCard>
                <PrincipleCard title="Guardrails first">
                  Risk, permissions, and kill-switches ship with v1 — not "coming soon".
                </PrincipleCard>
                <PrincipleCard title="Dignified onboarding">
                  Everyday-first language and progressive disclosure at every step.
                </PrincipleCard>
              </ul>
            </Section>

            <Section id="architecture" title="3 · Architecture">
              <p>
                The system is organized into a small set of well-scoped agents — the Turtle
                Collective — coordinated by Onyx.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <ArchRow label="Scout" body="Reconnaissance. Multi-timeframe scanning, read-only." />
                <ArchRow label="Onyx" body="Intelligence commander. Decides. Records. Explains." />
                <ArchRow label="Warden" body="Guardrails and preflight. The last line before capital moves." />
                <ArchRow label="Vanguard" body="Executor. Turns approved intent into precise, auditable orders." />
                <ArchRow label="Shadow" body="Defensive watcher. Break-of-structure detection on open positions." />
                <ArchRow label="Sentinel" body="Ops health. Freshness, latency, backlog, and last success." />
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <p className="type-eyebrow text-cyan-300/80">Data path per minute</p>
                <p className="mt-2 type-body-sm text-white/75">
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-cyan-200">Scout</code>{" "}
                  → <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-cyan-200">Ranker</code>{" "}
                  →{" "}
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-violet-200">Onyx</code>{" "}
                  → <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-amber-200">Warden</code>{" "}
                  →{" "}
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-emerald-200">
                    Vanguard
                  </code>{" "}
                  → your exchange. Every hop is audited.
                </p>
              </div>
            </Section>

            <Section id="safety" title="4 · Safety posture">
              <p>
                TurtleBot follows a fail-closed philosophy: if a component cannot verify the
                system's state, it refuses to act rather than guess. Human override, pause
                controls, and kill switches are surfaced across the app, not buried in settings.
              </p>
              <ul className="list-inside list-disc space-y-1 text-white/75">
                <li>Non-custodial by construction — no withdraw permission requested.</li>
                <li>Per-user cross-margin caps, per-symbol pod caps, drawdown floors.</li>
                <li>Idempotent order execution with reservation + audit records.</li>
                <li>Every strategy stop is deterministic and preflight-verified.</li>
              </ul>
            </Section>

            <Section id="economics" title="5 · Economics (planned)">
              <p>
                We plan to introduce a subscription model for advanced strategies and a utility
                token approximately 12 months from public launch, subject to jurisdictional and
                compliance review. Nothing on this page is an offer of securities.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <MiniStat label="Subscription" value="Planned" />
                <MiniStat label="Utility token" value="Target · ~12mo" />
                <MiniStat label="Governance" value="Planned" />
              </div>
            </Section>

            <Section id="governance" title="6 · Governance (planned)">
              <p>
                Following ecosystem maturity, we plan to introduce stakeholder governance for
                major ecosystem decisions. Governance mechanics will be published in advance and
                subject to community review.
              </p>
            </Section>

            <Section id="risks" title="7 · Risks & disclosures">
              <div className="rounded-2xl border border-rose-400/20 bg-rose-400/5 p-5 text-sm leading-relaxed text-rose-100/90">
                <p>
                  Trading digital assets involves substantial risk of loss. Automated systems can
                  and do lose money. Past results and paper-trading results do not predict future
                  results. Nothing in this whitepaper is financial, legal, or tax advice. Any
                  future token, subscription, or allocation program will be subject to
                  jurisdictional review, and eligibility may be restricted.
                </p>
              </div>
            </Section>

            <div className="flex flex-wrap gap-3 pt-4">
              <Link
                to="/roadmap"
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.03] px-5 py-2.5 text-sm text-white/85 backdrop-blur hover:bg-white/[0.06]"
              >
                See the roadmap
              </Link>
              <Link
                to="/home"
                className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 px-5 py-2.5 text-sm font-semibold text-black"
              >
                Enter the app
              </Link>
            </div>
          </article>
        </div>
        {/* Faint asset watermark for context */}
        <img
          src={brand.wordmark}
          alt=""
          aria-hidden
          className="pointer-events-none mx-auto mt-16 h-10 w-auto opacity-30"
        />
      </SectionShell>
    </MarketingShell>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28 space-y-4">
      <SectionHeading align="left" title={title} />
      <div className="type-body-lg space-y-4 text-white/75">{children}</div>
    </section>
  );
}

function PrincipleCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur">
      <p className="type-display-md text-white">{title}</p>
      <p className="mt-1 type-body-sm text-white/70">{children}</p>
    </li>
  );
}

function ArchRow({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p className="type-eyebrow text-cyan-300/90">{label}</p>
      <p className="mt-1 type-body-sm text-white/70">{body}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
      <p className="type-eyebrow text-white/50">{label}</p>
      <p className="mt-1 type-display-md text-white">{value}</p>
    </div>
  );
}
