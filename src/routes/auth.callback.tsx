import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { recordOnboardingDiagnostic } from "@/lib/onboarding-diagnostics";
import { ProgressDots } from "@/components/welcome/ProgressDots";
import { QuorumarkLogo } from "@/components/brand/QuorumarkLogo";
import { consumePaperEntry } from "@/lib/auth/paper-entry";

export const Route = createFileRoute("/auth/callback")({
  ssr: false,
  component: AuthCallback,
  head: () => ({
    meta: [{ title: "Signing you in · Quorumark" }, { name: "robots", content: "noindex" }],
  }),
});

function AuthCallback() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const routedRef = useRef(false);

  useEffect(() => {
    if (loading || routedRef.current) return;
    if (!user) {
      routedRef.current = true;
      recordOnboardingDiagnostic({
        route: window.location.pathname,
        source: "auth callback",
        status: "redirecting",
        detail: "No session on OAuth return; sending to /welcome",
      });
      navigate({ to: "/welcome", replace: true });
      return;
    }
    routedRef.current = true;
    void (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("onboarding_complete_v2")
        .eq("id", user.id)
        .maybeSingle();
      const done = !!data?.onboarding_complete_v2;
      recordOnboardingDiagnostic({
        route: window.location.pathname,
        source: "auth callback",
        status: "redirecting",
        detail: done
          ? "Onboarding complete; sending to /home"
          : "Onboarding incomplete; sending to /welcome/pin",
      });
      if (done && consumePaperEntry()) {
        navigate({ to: "/trade", search: { book: "paper" }, replace: true });
      } else {
        navigate({ to: done ? "/home" : "/welcome/pin", replace: true });
      }
    })();
  }, [loading, user, navigate]);

  return (
    <main className="auth-shell welcome-shell mx-auto flex min-h-[100dvh] w-full max-w-[430px] flex-col items-center px-5 pb-12 pt-5 text-center">
      <ProgressDots step={0} total={9} />
      <div className="mt-auto flex w-full justify-center">
        <QuorumarkLogo compact />
      </div>
      <div className="welcome-inset-panel mb-auto mt-10 w-full rounded-[24px] px-6 py-8">
        <Loader2 className="mx-auto h-7 w-7 animate-spin text-primary" />
        <h1 className="mt-4 font-display text-xl font-bold text-white">Signing you in</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Securing your session and preparing Quorumark…
        </p>
      </div>
    </main>
  );
}
