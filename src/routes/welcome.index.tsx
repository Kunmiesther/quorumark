import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useOnboardingRouteDiagnostics } from "@/lib/onboarding-diagnostics";
import { detectBrowserEnv, inAppBrowserMessage } from "@/lib/auth/mobileOAuth";
import { ProgressDots } from "@/components/welcome/ProgressDots";
import { rememberPaperEntry } from "@/lib/auth/paper-entry";

import { getPublicBackendEnvMessage, waitForPublicBackendEnv } from "@/lib/public-env";
import { QuorumarkLogo } from "@/components/brand/QuorumarkLogo";

export const Route = createFileRoute("/welcome/")({
  component: WelcomeIndex,
  head: () => ({
    meta: [{ title: "Welcome — Quorumark" }],
  }),
});

function WelcomeIndex() {
  const { user, loading } = useAuth();
  const [learnOpen, setLearnOpen] = useState(false);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [inAppNotice, setInAppNotice] = useState<string | null>(null);

  useOnboardingRouteDiagnostics({
    source: "welcome sign-in",
    loading,
    userId: user?.id,
    requiresAuth: false,
  });

  async function handleOAuth(provider: "google", paper = false) {
    if (busy) return;
    if (paper && user) {
      if (!rememberPaperEntry(true)) {
        toast.error("Allow browser session storage to remember paper mode, then try again.");
        return;
      }
      navigate({ to: "/trade", search: { book: "paper" } });
      return;
    }

    // Embedded webviews (ChatGPT, Instagram, …) are rejected by Google.
    const browserEnv = detectBrowserEnv();
    if (browserEnv.isInAppBrowser) {
      const msg = inAppBrowserMessage(browserEnv);
      setInAppNotice(msg);
      toast.error(msg, { duration: 8000 });
      return;
    }

    setInAppNotice(null);
    setBusy(true);
    const id = `${provider}-oauth`;
    const providerLabel = "Google";
    toast.loading(`Opening ${providerLabel}…`, { id });

    const env = await waitForPublicBackendEnv();
    if (!env.ok) {
      toast.error(getPublicBackendEnvMessage(env.missing), { id });
      setBusy(false);
      return;
    }
    try {
      if (!rememberPaperEntry(paper) && paper) {
        throw new Error("Allow browser session storage to remember paper mode, then try again.");
      }
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      toast.dismiss(id);
    } catch (err) {
      toast.error(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`, { id });
      setBusy(false);
    }
  }

  return (
    <div className="relative flex flex-1 flex-col">
      <ProgressDots step={0} total={9} />

      {/* Logo-only hero: onboarding stays focused on the Quorumark control room. */}
      <div className="welcome-hero relative flex min-h-[305px] w-full flex-col items-center justify-center px-3">
        <div className="welcome-logo-aura absolute left-1/2 top-[46%] h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full" />
        <div className="relative z-10 flex -translate-y-2 flex-col items-center">
          <div className="welcome-logo-plinth flex h-[218px] w-[218px] items-center justify-center overflow-hidden rounded-full">
            <QuorumarkLogo />
          </div>
          <h1 className="mt-3 text-center font-display text-[27px] font-bold leading-[1.15] tracking-[-0.025em] text-white">
            Finance that answers to <span className="text-primary">your rules</span>
          </h1>
        </div>
      </div>

      {/* Auth stack on clean black */}
      <div className="grid grid-cols-2 gap-3 px-1 pb-5 pt-0">
        {inAppNotice && (
          <div
            role="alert"
            className="col-span-2 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-[12px] leading-relaxed text-white"
          >
            {inAppNotice}
          </div>
        )}
        <button
          type="button"
          onClick={() => handleOAuth("google", true)}
          disabled={busy || loading}
          className="welcome-neo-button col-span-2 rounded-[20px] border border-violet-400/25 px-4 py-3 text-sm text-violet-200 disabled:opacity-60"
        >
          {user ? "Open paper trading" : "Try paper trading with Google"}
          <span className="mt-1 block text-xs text-muted-foreground">
            Paper access required · no deposit or wallet needed
          </span>
        </button>
        <button
          type="button"
          onClick={() => handleOAuth("google")}
          disabled={busy}
          aria-busy={busy}
          className="welcome-neo-button flex h-[58px] items-center justify-center gap-2 rounded-[20px] text-[13px] font-semibold text-white disabled:opacity-60"
        >
          <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.61Z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.32A9 9 0 0 0 9 18Z"
            />
            <path
              fill="#FBBC05"
              d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.32Z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.42 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.32C4.68 5.16 6.66 3.58 9 3.58Z"
            />
          </svg>
          {busy ? "Opening…" : "Google"}
        </button>
        {/* Subtle divider */}
        <div className="col-span-2 my-2 flex items-center gap-3">
          <div className="welcome-divider h-1 flex-1 rounded-full" />
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            or
          </span>
          <div className="welcome-divider h-1 flex-1 rounded-full" />
        </div>

        <Link
          to="/auth"
          className="welcome-neo-button col-span-2 flex h-[54px] items-center justify-center rounded-[19px] text-[14px] font-medium text-foreground/90"
        >
          Log In with Email
        </Link>
        <Link
          to="/auth"
          hash="signup"
          className="col-span-2 flex h-8 items-center justify-center text-[12px] font-medium text-muted-foreground transition hover:text-foreground"
        >
          Create Account
        </Link>

        <button
          type="button"
          onClick={() => setLearnOpen((v) => !v)}
          aria-expanded={learnOpen}
          aria-controls="welcome-learn-more"
          className="col-span-2 mt-2 flex h-8 items-center justify-center gap-1.5 text-[11.5px] font-medium text-muted-foreground/80 transition hover:text-foreground"
        >
          Learn More
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${learnOpen ? "rotate-180" : ""}`}
          />
        </button>

        {learnOpen && (
          <div
            id="welcome-learn-more"
            className="welcome-inset-panel col-span-2 mt-2 space-y-3 rounded-2xl p-4 text-[12.5px] leading-relaxed text-muted-foreground"
          >
            <p className="text-foreground">
              Quorumark is a decision control room where specialized agents challenge financial
              actions against your explicit rules.
            </p>
            <p>
              Every order is simulated by default. Real execution stays locked until you explicitly
              authorize it. Your credentials are encrypted server-side and never leave the vault in
              plaintext.
            </p>
            <p>
              No connections, wallets, or exchanges are touched until after you sign in and complete
              a short onboarding.
            </p>
          </div>
        )}

        <div className="col-span-2 mt-4 flex flex-wrap items-center justify-center gap-2">
          {[
            {
              name: "TurtleBot on Facebook",
              href: "https://www.facebook.com/Turtlebotapp/",
              d: "M13.5 21v-8h2.7l.4-3.1h-3.1V7.9c0-.9.3-1.5 1.6-1.5h1.6V3.6c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1V9.9H7.6V13h2.7v8h3.2z",
            },
            {
              name: "TurtleBot on Instagram (@turtleturtlebot)",
              href: "https://www.instagram.com/turtleturtlebot/",
              d: "M12 2.2c3.2 0 3.6 0 4.8.1 1.2.1 1.8.3 2.2.4.6.2 1 .5 1.4.9.4.4.7.9.9 1.4.2.4.4 1 .4 2.2.1 1.2.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 1.2-.3 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.9.7-1.4.9-.4.2-1 .4-2.2.4-1.2.1-1.6.1-4.8.1s-3.6 0-4.8-.1c-1.2-.1-1.8-.3-2.2-.4-.6-.2-1-.5-1.4-.9-.4-.4-.7-.9-.9-1.4-.2-.4-.4-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.8c.1-1.2.3-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.9-.7 1.4-.9.4-.2 1-.4 2.2-.4C8.4 2.2 8.8 2.2 12 2.2m0 2.2c-3.1 0-3.5 0-4.7.1-1.1.1-1.7.2-2.1.4-.5.2-.9.5-1.3.8-.4.4-.6.7-.8 1.3-.1.4-.3 1-.4 2.1C2.6 8.5 2.6 8.9 2.6 12s0 3.5.1 4.7c.1 1.1.2 1.7.4 2.1.2.5.5.9.8 1.3.4.4.7.6 1.3.8.4.1 1 .3 2.1.4 1.2.1 1.6.1 4.7.1s3.5 0 4.7-.1c1.1-.1 1.7-.2 2.1-.4.5-.2.9-.5 1.3-.8.4-.4.6-.7.8-1.3.1-.4.3-1 .4-2.1.1-1.2.1-1.6.1-4.7s0-3.5-.1-4.7c-.1-1.1-.2-1.7-.4-2.1-.2-.5-.5-.9-.8-1.3-.4-.4-.7-.6-1.3-.8-.4-.1-1-.3-2.1-.4C15.5 4.4 15.1 4.4 12 4.4zm0 3.3a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6zm0 7.1a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zm5.5-7.3a1 1 0 1 1-2 0 1 1 0 0 1 2 0z",
            },
            {
              name: "TikTok",
              href: "https://tiktok.com",
              d: "M16.5 3c.3 1.7 1.3 3 3 3.4v2.4c-1.1 0-2.1-.3-3-.9v5.7c0 3.4-2.7 6-6 6s-6-2.7-6-6c0-3.3 2.6-6 5.9-6l.4.1v2.5l-.4-.1c-1.9 0-3.4 1.5-3.4 3.5s1.5 3.5 3.4 3.5S13.9 15.5 14 14V3h2.5z",
            },
            {
              name: "TurtleBot on X (@turtlebotapp)",
              href: "https://x.com/turtlebotapp",
              d: "M17.5 3h3l-6.5 7.5L21 21h-5.6l-4.4-5.7L5.6 21H2.6l7-8L2 3h5.7l4 5.3L17.5 3zm-1 16h1.7L7.5 4.8H5.7L16.5 19z",
            },
            {
              name: "Twitch",
              href: "https://twitch.tv",
              d: "M4 3l-1 3v13h4v2h2l2-2h3l5-5V3H4zm14 10l-3 3h-3l-2 2v-2H6V5h12v8zm-3-5v4h-1.5V8H15zm-4 0v4H9.5V8H11z",
            },
            {
              name: "YouTube",
              href: "https://youtube.com",
              d: "M23 12s0-3.6-.5-5.3c-.2-.9-1-1.7-1.9-1.9C18.9 4.3 12 4.3 12 4.3s-6.9 0-8.6.5c-.9.2-1.7 1-1.9 1.9C1 8.4 1 12 1 12s0 3.6.5 5.3c.2.9 1 1.7 1.9 1.9 1.7.5 8.6.5 8.6.5s6.9 0 8.6-.5c.9-.2 1.7-1 1.9-1.9.5-1.7.5-5.3.5-5.3zM9.8 15.3V8.7l5.7 3.3-5.7 3.3z",
            },
            {
              name: "Snapchat",
              href: "https://snapchat.com",
              d: "M12 2.5c3.1 0 5.1 2.4 5.1 5.4 0 1.8-.3 3.1-.4 3.4.6.3 1.5.5 2 .5.4 0 .8-.1 1-.2.2 0 .3.1.4.3.1.5-1.2 1.1-2.3 1.4-.2 0-.2.2-.2.4 0 .2.6 1.9 3.4 2.4.2 0 .3.2.3.4-.1.5-1.4 1-3 1.2-.1.2-.2.7-.3 1-.1.1-.2.2-.4.2H17c-.6 0-1.4.1-2.3.6-.9.6-1.7 1.5-3.7 1.5S8.2 20.1 7.3 19.5c-.9-.6-1.7-.6-2.3-.6h-.7c-.2 0-.3-.1-.4-.2-.1-.3-.2-.8-.3-1-1.6-.2-2.9-.7-3-1.2 0-.2.1-.4.3-.4 2.8-.5 3.4-2.2 3.4-2.4 0-.2-.1-.4-.2-.4-1.1-.3-2.4-.9-2.3-1.4 0-.2.2-.3.4-.3.2.1.6.2 1 .2.5 0 1.4-.2 2-.5-.1-.3-.4-1.6-.4-3.4 0-3 2-5.4 5.1-5.4z",
            },
            {
              name: "Discord",
              href: "https://discord.gg/lovable-dev",
              d: "M20 5.3A17 17 0 0 0 15.9 4l-.2.4c1.5.4 2.9 1 4.1 1.8-1.5-1-3.2-1.5-5-1.7-1.5-.2-3.1-.2-4.6 0-1.8.2-3.5.7-5 1.7 1.2-.8 2.6-1.4 4.1-1.8L9.1 4C7.6 4.3 6.2 4.7 5 5.3 2.4 9.6 1.7 13.7 2 17.8c1.5 1.1 3.2 1.8 5 2.2l.6-1c-1.3-.4-2.5-.9-3.6-1.7l.4-.2c2.4 1.1 5 1.6 7.6 1.6s5.2-.5 7.6-1.6l.4.2c-1.1.8-2.3 1.3-3.6 1.7l.6 1c1.8-.4 3.5-1.1 5-2.2.4-4.7-.7-8.8-2.4-12.5zM8.7 15.3c-1 0-1.9-.9-1.9-2.1s.8-2.1 1.9-2.1c1 0 1.9.9 1.9 2.1-.1 1.2-.9 2.1-1.9 2.1zm6.6 0c-1 0-1.9-.9-1.9-2.1s.8-2.1 1.9-2.1c1 0 1.9.9 1.9 2.1s-.9 2.1-1.9 2.1z",
            },
            {
              name: "Telegram",
              href: "https://telegram.org",
              d: "M21.5 4.2 2.9 11.4c-1.3.5-1.3 1.2-.2 1.5l4.8 1.5 1.8 5.6c.2.6.1.9.8.9.5 0 .7-.2 1-.5l2.4-2.3 4.9 3.6c.9.5 1.5.2 1.8-.8l3.2-15.1c.3-1.2-.4-1.7-1.3-1.3zM8.3 14.9l10.4-6.6c.5-.3 1-.1.6.2l-8.6 7.8-.3 3.5-2.1-4.9z",
            },
          ].map((s) => (
            <a
              key={s.name}
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={s.name}
              className="welcome-social flex h-8 w-8 items-center justify-center rounded-full text-[#ad72ff] transition active:scale-90"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d={s.d} />
              </svg>
            </a>
          ))}
        </div>
      </div>

      <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
        By continuing, you agree to our{" "}
        <Link to="/terms" className="text-foreground underline-offset-2 hover:underline">
          Terms &amp; Conditions
        </Link>{" "}
        and{" "}
        <Link to="/privacy" className="text-foreground underline-offset-2 hover:underline">
          Privacy Policy
        </Link>
        .
      </p>
      <p className="mt-1 mb-2 text-center text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
        Quorumark preview environment
      </p>
    </div>
  );
}
