import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RefreshCw, ScanFace } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { recordOnboardingDiagnostic, useOnboardingRouteDiagnostics } from "@/lib/onboarding-diagnostics";
import { Mascot } from "@/components/welcome/Mascot";
import { ProgressDots } from "@/components/welcome/ProgressDots";

export const Route = createFileRoute("/welcome/face-id")({
  component: FaceIdStep,
  head: () => ({ meta: [{ title: "Enable Face ID — Turtle Bot" }] }),
});

function FaceIdStep() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [busy, setBusy] = useState(false);
  useOnboardingRouteDiagnostics({ source: "Face ID passkey", loading, userId: user?.id });

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/welcome" });
  }, [loading, user, navigate]);

  async function enableFaceId() {
    if (!user || busy) return;
    if (!window.PublicKeyCredential || !navigator.credentials) {
      toast.error("Face ID or passkeys are not supported on this device.");
      return;
    }

    setBusy(true);
    try {
      const { error: passkeyError } = await supabase.auth.registerPasskey();
      if (passkeyError) throw passkeyError;

      const { error: profileError } = await supabase
        .from("profiles")
        .update({ face_id_enabled: true })
        .eq("id", user.id);
      if (profileError) throw profileError;

      recordOnboardingDiagnostic({
        route: window.location.pathname,
        source: "Face ID passkey",
        status: "redirecting",
        detail: "Passkey enrolled; sending to /welcome/exchange",
      });
      toast.success("Face ID enabled");
      navigate({ to: "/welcome/exchange" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Face ID could not be enabled.");
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    if (busy) return;
    if (user) {
      const { error } = await supabase.from("profiles").update({ face_id_enabled: false }).eq("id", user.id);
      if (error) {
        toast.error(error.message);
        return;
      }
    }
    navigate({ to: "/welcome/exchange" });
  }

  if (loading || !user) return null;

  return (
    <div className="flex flex-1 flex-col">
      <ProgressDots step={2} total={9} />
      <div className="mt-10"><Mascot slug="ema-cross" /></div>
      <div className="mt-6 flex items-center justify-center">
        <div className="welcome-wallet-icon flex h-14 w-14 items-center justify-center rounded-full">
          <ScanFace className="h-7 w-7 text-primary" />
        </div>
      </div>
      <h1 className="mt-5 text-center font-display text-2xl font-bold tracking-tight">Enable Face ID</h1>
      <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
        Use Face ID for fast, secure access. Your 6-digit PIN remains available as a fallback.
      </p>
      <div className="mt-auto flex flex-col gap-2.5 pt-10">
        <button onClick={enableFaceId} disabled={busy} className="welcome-primary-action flex h-14 items-center justify-center gap-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
          {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
          {busy ? "Waiting for Face ID…" : "Enable Face ID"}
        </button>
        <button onClick={skip} disabled={busy} className="welcome-secondary-action flex h-14 items-center justify-center text-sm font-medium text-foreground disabled:opacity-60">Not now</button>
      </div>
    </div>
  );
}
