import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { previewInvitation, redeemInvitation } from "@/lib/community/community.functions";
import { planDef } from "@/lib/community/communityPlans";
import { supabase } from "@/integrations/supabase/client";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { GlassCard, SectionShell } from "@/components/marketing/primitives";

const TITLE = "You're invited — TurtleBot";
const DESC = "Redeem your community invitation and start paper trading on the TurtleBot deterministic pipeline.";

export const Route = createFileRoute("/invite/$token")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: InvitePage,
});

const REASON_COPY: Record<string, string> = {
  INVITE_NOT_FOUND: "This invitation link is not recognised. Check the link, or ask your community leader for a new one.",
  INVITE_REVOKED: "This invitation was revoked by the community leader.",
  INVITE_EXPIRED: "This invitation has expired. Ask your community leader to send a fresh one.",
  INVITE_EXHAUSTED: "Every seat on this invitation has already been claimed.",
  INVITE_EMAIL_MISMATCH: "This invitation is locked to a different email address. Sign in with the invited address.",
  COMMUNITY_NOT_ACTIVE: "This community is not currently active on TurtleBot.",
  SEAT_LIMIT_REACHED: "This community has no seats left.",
  NOT_AUTHENTICATED: "Please sign in to redeem your invitation.",
};

function InvitePage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const preview = useServerFn(previewInvitation);
  const redeem = useServerFn(redeemInvitation);

  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof previewInvitation>> | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [risk, setRisk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [p, session] = await Promise.all([
        preview({ data: { token } }).catch(() => null),
        supabase.auth.getSession(),
      ]);
      if (!alive) return;
      setInfo(p as never);
      setSignedIn(Boolean(session.data.session));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [preview, token]);

  async function onRedeem() {
    setBusy(true);
    setError(null);
    try {
      const result = await redeem({ data: { token } });
      if (result.ok) {
        navigate({ to: "/home" });
        return;
      }
      setError(REASON_COPY[result.reason] ?? "This invitation could not be redeemed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "This invitation could not be redeemed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <MarketingShell>
      <SectionShell className="pt-16">
        <GlassCard className="mx-auto max-w-lg p-7">
          {loading ? (
            <p className="text-sm text-muted-foreground">Checking your invitation…</p>
          ) : !info || !info.community ? (
            <Invalid reason={REASON_COPY["INVITE_NOT_FOUND"]!} />
          ) : !info.ok ? (
            <Invalid reason={REASON_COPY[info.reason ?? ""] ?? "This invitation is no longer valid."} />
          ) : (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                {info.community.logo_url ? (
                  <img
                    src={info.community.logo_url}
                    alt={`${info.community.name} logo`}
                    className="h-10 w-10 rounded-lg object-cover"
                  />
                ) : null}
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Invited by</p>
                  <h1 className="text-lg font-semibold">{info.community.name}</h1>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Plan</dt>
                  <dd>{planDef(info.plan_key ?? "").name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Expires</dt>
                  <dd>{new Date(info.expires_at ?? "").toLocaleDateString()}</dd>
                </div>
              </dl>

              <p className="rounded-lg border border-border/60 bg-background/40 p-3 text-xs leading-relaxed text-muted-foreground">
                This seat is <span className="text-foreground">paper trading only</span>. No real
                money is traded, no funds are requested, and nothing here is financial advice. Paper
                results do not predict live results.
              </p>

              {signedIn ? (
                <>
                  <label className="flex items-start gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={risk}
                      onChange={(e) => setRisk(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>I understand this is a paper-trading simulation and accept the risk notice.</span>
                  </label>
                  {error && <p className="text-xs text-red-400">{error}</p>}
                  <button
                    onClick={onRedeem}
                    disabled={!risk || busy}
                    className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {busy ? "Claiming your seat…" : "Claim my seat"}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => navigate({ to: "/auth", search: { next: `/invite/${token}` } as never })}
                  className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
                >
                  Sign in to claim your seat
                </button>
              )}
            </div>
          )}
        </GlassCard>
      </SectionShell>
    </MarketingShell>
  );
}

function Invalid({ reason }: { reason: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">This invitation isn&apos;t usable</h1>
      <p className="text-sm text-muted-foreground">{reason}</p>
      <a
        href="/apply"
        className="inline-block rounded-lg border border-border/60 px-4 py-2 text-sm font-medium"
      >
        Apply for community access
      </a>
    </div>
  );
}
