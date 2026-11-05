import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { Bell, RefreshCw } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  recordOnboardingDiagnostic,
  useOnboardingRouteDiagnostics,
} from "@/lib/onboarding-diagnostics";
import { Mascot } from "@/components/welcome/Mascot";
import { ProgressDots } from "@/components/welcome/ProgressDots";
import { requestPushNotifications } from "@/lib/native-runtime";

export const Route = createFileRoute("/welcome/notifications")({
  component: NotificationsStep,
  head: () => ({ meta: [{ title: "Enable notifications — Turtle Bot" }] }),
});

function NotificationsStep() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [busy, setBusy] = useState(false);
  useOnboardingRouteDiagnostics({ source: "notifications", loading, userId: user?.id });

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/welcome" });
  }, [loading, user, navigate]);

  async function choose(requested: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      let enabled = false;
      if (requested) {
        if (!user) throw new Error("Please sign in again before enabling notifications.");
        enabled = await requestPushNotifications(user.id);
        if (!enabled) {
          toast.error("Notifications were not enabled. You can turn them on later in Settings.");
        }
      }

      if (user) {
        const { error } = await supabase
          .from("profiles")
          .update({ notifications_enabled: enabled })
          .eq("id", user.id);
        if (error) throw error;
      }

      recordOnboardingDiagnostic({
        route: window.location.pathname,
        source: "notifications guard",
        status: "redirecting",
        detail: `${enabled ? "Enabled" : "Skipped or denied"}; sending to /welcome/ai-model`,
      });
      navigate({ to: "/welcome/ai-model" });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save notification preference.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <ProgressDots step={5} total={9} />
      <div className="mt-10">
        <Mascot slug="dca" />
      </div>
      <div className="mt-6 flex items-center justify-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05]">
          <Bell className="h-6 w-6 text-primary" />
        </div>
      </div>
      <h1 className="mt-5 text-center font-display text-2xl font-bold tracking-tight">
        Enable notifications
      </h1>
      <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
        Trade fills, risk alerts, daily harvests — we'll keep it quiet otherwise.
      </p>

      <div className="mt-auto flex flex-col gap-2.5 pt-10">
        <button
          onClick={() => choose(true)}
          disabled={busy}
          className="welcome-primary-action flex h-14 items-center justify-center text-sm font-semibold text-primary-foreground"
        >
          {busy && <RefreshCw className="mr-2 h-4 w-4 animate-spin" />}
          {busy ? "Saving…" : "Turn on notifications"}
        </button>
        <button
          onClick={() => choose(false)}
          disabled={busy}
          className="welcome-secondary-action flex h-14 items-center justify-center text-sm font-medium text-foreground"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
