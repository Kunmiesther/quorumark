import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { applyForCommunity } from "@/lib/community/community.functions";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import {
  GlassCard,
  GradientText,
  SectionHeading,
  SectionShell,
  StatusPill,
} from "@/components/marketing/primitives";

const CANONICAL = "https://turtle-trade-guard.lovable.app/apply";
const TITLE = "Apply — Bring your community to TurtleBot";
const DESC =
  "TurtleBot is invite-only. Apply to run a community: your members get paper trading with the deterministic pipeline. Reviewed manually by Onixus.";

export const Route = createFileRoute("/apply")({
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
  component: ApplyPage,
});

function ApplyPage() {
  const submit = useServerFn(applyForCommunity);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setState("sending");
    try {
      await submit({ data: { name, slug, email, note } });
      setState("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the application.");
      setState("idle");
    }
  }

  return (
    <MarketingShell>
      <SectionShell className="pt-14 sm:pt-20">
        <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
          <div className="space-y-6">
            <StatusPill accent="violet">Invite-only · Applications reviewed manually</StatusPill>
            <SectionHeading
              align="left"
              eyebrow="Community access"
              title={
                <>
                  Bring your community <GradientText>to the desk.</GradientText>
                </>
              }
              subtitle="TurtleBot is not open signup. Communities apply, Onixus reviews, and approved leaders get a fixed number of seats to invite their members. Every seat starts on paper."
            />
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>· Members get paper trading on the same deterministic pipeline.</li>
              <li>· Live trading is not included and is not sold here.</li>
              <li>· Seats are fixed. You cannot invite past your limit.</li>
              <li>· Member results are shown to you in aggregate only.</li>
            </ul>
          </div>

          <GlassCard className="p-6">
            {state === "sent" ? (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold">Application received</h2>
                <p className="text-sm text-muted-foreground">
                  Your community is queued for review. Nothing is active yet — Onixus approves each
                  community manually and sets your seat count at that point. We will reply to{" "}
                  <span className="text-foreground">{email}</span>.
                </p>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-4">
                <h2 className="text-lg font-semibold">Community application</h2>
                <Field label="Community name">
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputClass}
                    placeholder="Example Traders"
                  />
                </Field>
                <Field label="Handle" hint="Lowercase, used in your invite links.">
                  <input
                    required
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    className={inputClass}
                    placeholder="example-traders"
                  />
                </Field>
                <Field label="Contact email">
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                    placeholder="you@community.com"
                  />
                </Field>
                <Field label="Anything we should know?" hint="Optional.">
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={4}
                    className={inputClass}
                    placeholder="Size of your community, what you trade, why TurtleBot."
                  />
                </Field>
                {error && <p className="text-xs text-red-400">{error}</p>}
                <button
                  type="submit"
                  disabled={state === "sending"}
                  className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {state === "sending" ? "Submitting…" : "Submit application"}
                </button>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Submitting does not create an account, grant access, or reserve seats.
                </p>
              </form>
            )}
          </GlassCard>
        </div>
      </SectionShell>
    </MarketingShell>
  );
}

const inputClass =
  "w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm outline-none focus:border-primary/60";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}
