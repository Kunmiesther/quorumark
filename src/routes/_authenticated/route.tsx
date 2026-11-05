import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { recordOnboardingDiagnostic } from "@/lib/onboarding-diagnostics";
import { AppShell } from "@/components/shell/AppShell";
import { waitForPublicBackendEnv } from "@/lib/public-env";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Guard: missing public build vars would make the supabase Proxy throw
    // and crash the whole route tree instead of showing the welcome flow.
    const env = await waitForPublicBackendEnv();
    if (!env.ok) {
      throw redirect({ to: "/welcome" });
    }
    recordOnboardingDiagnostic({
      route: window.location.pathname,
      source: "authenticated route guard",
      status: "checking user",
    });

    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      recordOnboardingDiagnostic({
        route: window.location.pathname,
        source: "authenticated route guard",
        status: "redirecting",
        detail: "No user; sending to /welcome",
      });
      throw redirect({ to: "/welcome" });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("onboarding_complete_v2, onboarding_complete")
      .eq("id", data.user.id)
      .maybeSingle();

    // Auto-migrate users who completed the legacy onboarding to v2.
    if (!profile?.onboarding_complete_v2 && profile?.onboarding_complete) {
      await supabase
        .from("profiles")
        .update({ onboarding_complete_v2: true })
        .eq("id", data.user.id);
      recordOnboardingDiagnostic({
        route: window.location.pathname,
        source: "authenticated route guard",
        status: "allowed",
        detail: "Auto-migrated legacy onboarding to v2",
      });
      return { user: data.user };
    }

    if (!profile?.onboarding_complete_v2) {

      recordOnboardingDiagnostic({
        route: window.location.pathname,
        source: "authenticated route guard",
        status: "redirecting",
        detail: "Onboarding incomplete; sending to /welcome/pin",
      });
      throw redirect({ to: "/welcome/pin" });
    }
    recordOnboardingDiagnostic({
      route: window.location.pathname,
      source: "authenticated route guard",
      status: "allowed",
      detail: "Onboarding complete",
    });
    return { user: data.user };
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
