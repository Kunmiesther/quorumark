import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { recordOnboardingDiagnostic, useOnboardingRouteDiagnostics } from "@/lib/onboarding-diagnostics";
import { Mascot } from "@/components/welcome/Mascot";
import { ProgressDots } from "@/components/welcome/ProgressDots";
import { consumePaperEntry } from "@/lib/auth/paper-entry";

export const Route = createFileRoute("/welcome/ready")({
  component: Ready,
  head: () => ({ meta: [{ title: "You're ready — Turtle Bot" }] }),
});

function Ready() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useOnboardingRouteDiagnostics({ source: "ready", loading, userId: user?.id });

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/welcome" });
      return;
    }
    void (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .maybeSingle();
      setName(data?.display_name ?? user.email?.split("@")[0] ?? "trader");
    })();
  }, [loading, user, navigate]);

  async function finish() {
    if (!user) return;
    setBusy(true);
    const { error } = await supabase
      .from("profiles")
      .update({ onboarding_complete_v2: true })
      .eq("id", user.id);
    if (error) {
      toast.error(error.message);
      setBusy(false);
      return;
    }
    recordOnboardingDiagnostic({
      route: window.location.pathname,
      source: "ready guard",
      status: "redirecting",
      detail: "Onboarding marked complete; sending to /home",
    });
    if (consumePaperEntry()) navigate({ to: "/trade", search: { book: "paper" } });
    else navigate({ to: "/home" });
  }

  return (
    <div className="flex flex-1 flex-col">
      <ProgressDots step={8} total={9} />
      <div className="mt-10">
        <Mascot slug="ema-cross" size={180} />
      </div>
      <h1 className="mt-8 text-center font-display text-[28px] font-bold tracking-tight">
        Hi {name ?? "…"}, you are set.
      </h1>
      <p className="mt-2 text-center text-sm text-muted-foreground">Your TurtleBot workspace is ready.</p>

      <button
        onClick={finish}
        disabled={busy || !name}
        className="welcome-primary-action mt-auto flex h-14 items-center justify-center gap-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
        Continue
      </button>
    </div>
  );
}
