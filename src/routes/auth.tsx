import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useEffect } from "react";
import { getPublicBackendEnvMessage, waitForPublicBackendEnv } from "@/lib/public-env";
import { detectBrowserEnv, inAppBrowserMessage } from "@/lib/auth/mobileOAuth";
import { QuorumarkLogo } from "@/components/brand/QuorumarkLogo";

export const Route = createFileRoute("/auth")({
  ssr: false,
  component: AuthPage,
  head: () => ({
    meta: [
      { title: "Sign in · Quorumark" },
      { name: "description", content: "Sign in or create your Quorumark account." },
    ],
  }),
});

const schema = z.object({
  email: z.string().trim().email("Enter a valid email").max(255),
  password: z.string().min(8, "Use at least 8 characters").max(128),
});

function AuthPage() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  // Which social button is mid-flight (spinner + disabled), and a persistent
  // on-page notice for embedded browsers where Google OAuth cannot run.
  const [oauthPending, setOauthPending] = useState<"google" | null>(null);
  const [inAppNotice, setInAppNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && session) navigate({ to: "/home" });
  }, [loading, session, navigate]);

  // Welcome page links to /auth#signup for the Create Account CTA.
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#signup") {
      setMode("signup");
    }
  }, []);

  async function handleEmail(e: FormEvent) {
    e.preventDefault();
    const env = await waitForPublicBackendEnv();
    if (!env.ok) {
      toast.error(getPublicBackendEnvMessage(env.missing));
      return;
    }
    const parsed = (mode === "forgot" ? schema.pick({ email: true }) : schema).safeParse({
      email,
      password,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Check your details");
      return;
    }
    const parsedEmail = parsed.data.email;
    const parsedPassword = "password" in parsed.data ? parsed.data.password : "";
    if (mode === "signup" && !consent) {
      toast.error("Please accept the Terms, Privacy Policy and Risk Disclosure first.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
          redirectTo: `${window.location.origin}/auth`,
        });
        if (error) throw error;
        toast.success("If an account exists for that email, a reset link is on its way.");
        setMode("signin");
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: parsedEmail,
          password: parsedPassword,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (data.session) {
          navigate({ to: "/welcome/pin" });
        } else {
          toast.success("Account created. Please confirm your email, then sign in.");
          setMode("signin");
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: parsedEmail,
          password: parsedPassword,
        });
        if (error) throw error;
        if (!data.session) {
          toast.error("Please confirm your email before signing in.");
          return;
        }
        navigate({ to: "/home" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleOAuth(provider: "google") {
    if (busy || oauthPending) return;
    if (mode === "signup" && !consent) {
      toast.error("Please accept the Terms, Privacy Policy and Risk Disclosure first.");
      return;
    }

    // Embedded webviews (ChatGPT, Instagram, …) are refused by Google with
    // "disallowed_useragent". The Lovable preview iframe is NOT one of these —
    // the auth helper handles it — so only real in-app browsers are blocked.
    const browserEnv = detectBrowserEnv();
    if (browserEnv.isInAppBrowser) {
      const msg = inAppBrowserMessage(browserEnv);
      setInAppNotice(msg);
      toast.error(msg, { duration: 8000 });
      return;
    }

    setInAppNotice(null);
    setOauthPending(provider);
    const toastId = `${provider}-oauth`;
    toast.loading("Opening Google…", { id: toastId });

    const env = await waitForPublicBackendEnv();
    if (!env.ok) {
      toast.error(getPublicBackendEnvMessage(env.missing), { id: toastId });
      setOauthPending(null);
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      // Supabase performs a same-tab redirect by default. Keep the pending
      // state active until the browser leaves this page.
      toast.dismiss(toastId);
    } catch (err) {
      toast.error(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`, {
        id: toastId,
      });
      setBusy(false);
      setOauthPending(null);
    }
  }

  const handleGoogle = () => handleOAuth("google");

  return (
    <main className="q-auth-shell auth-shell welcome-shell mx-auto flex min-h-[100dvh] w-full max-w-[430px] flex-col overflow-x-hidden px-5 pb-12 pt-5">
      <QuorumarkLogo className="mt-4" />
      <div className="q-auth-heading">
        <p className="q-auth-kicker">Decision control room</p>
        <h2 className="text-2xl font-semibold tracking-tight">
          {mode === "signin"
            ? "Welcome back"
            : mode === "signup"
              ? "Create your account"
              : "Reset your password"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "forgot"
            ? "Enter your email and we will send a secure password reset link."
            : "Review financial decisions with explicit policies and an auditable agent council."}
        </p>
      </div>

      {inAppNotice && (
        <div
          role="alert"
          className="mt-6 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-[12px] leading-relaxed text-foreground"
        >
          {inAppNotice}
        </div>
      )}

      {mode !== "forgot" && (
        <div className="mt-8 grid w-full grid-cols-1 gap-2">
          <button
            onClick={handleGoogle}
            disabled={busy || oauthPending !== null}
            aria-busy={oauthPending === "google"}
            className="welcome-neo-button flex h-12 min-w-0 items-center justify-center gap-2 rounded-2xl border text-[12px] font-medium text-white disabled:opacity-50"
          >
            {oauthPending === "google" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <GoogleIcon />
            )}
            {oauthPending === "google" ? "Opening…" : "Google"}
          </button>
        </div>
      )}

      {mode !== "forgot" && (
        <div className="my-6 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          or email
          <div className="h-px flex-1 bg-border" />
        </div>
      )}

      <form onSubmit={handleEmail} className="space-y-3">
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-12 w-full rounded-xl border border-border bg-surface px-4 text-sm outline-none transition placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/30"
        />
        {mode !== "forgot" && (
          <input
            type="password"
            required
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            placeholder="Password (min 8 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-12 w-full rounded-xl border border-border bg-surface px-4 text-sm outline-none transition placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/30"
          />
        )}
        {mode === "signup" && (
          <label className="flex items-start gap-2 pt-1 text-[12px] leading-relaxed text-muted-foreground">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            />
            <span>
              I am 18 or older and I agree to the{" "}
              <Link to="/terms" className="q-auth-link hover:underline">
                Terms of Service
              </Link>
              ,{" "}
              <Link to="/privacy" className="q-auth-link hover:underline">
                Privacy Policy
              </Link>{" "}
              and{" "}
              <Link to="/risk-disclosure" className="q-auth-link hover:underline">
                Risk Disclosure
              </Link>
              .
            </span>
          </label>
        )}
        <button
          type="submit"
          disabled={busy || (mode === "signup" && !consent)}
          className="welcome-primary-action flex h-14 w-full items-center justify-center gap-2 text-[12px] font-semibold text-white disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
        </button>
      </form>

      {mode === "signin" && (
        <button
          type="button"
          onClick={() => setMode("forgot")}
          className="q-auth-link mt-4 text-left text-sm"
        >
          Forgot password?
        </button>
      )}

      <button
        type="button"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        className="auth-mode-toggle mt-6 rounded-2xl py-3 text-center text-sm text-muted-foreground transition hover:text-foreground"
      >
        {mode === "signin" ? (
          <>
            New here? <span className="q-auth-link">Create an account</span>
          </>
        ) : (
          <>
            Already have an account? <span className="q-auth-link">Sign in</span>
          </>
        )}
      </button>

      <p className="mt-auto pt-10 text-center text-[11px] leading-relaxed text-muted-foreground">
        Trading involves real risk of loss. Past or simulated performance does not guarantee future
        results.
      </p>
      <nav className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <Link to="/privacy" className="hover:text-foreground">
          Privacy
        </Link>
        <Link to="/terms" className="hover:text-foreground">
          Terms
        </Link>
        <Link to="/data-deletion" className="hover:text-foreground">
          Data Deletion
        </Link>
        <Link to="/support" className="hover:text-foreground">
          Support
        </Link>
      </nav>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
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
  );
}
