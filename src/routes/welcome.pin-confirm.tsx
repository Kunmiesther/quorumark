import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { hashPin } from "@/lib/onboarding";
import { recordOnboardingDiagnostic, useOnboardingRouteDiagnostics } from "@/lib/onboarding-diagnostics";
import { Mascot } from "@/components/welcome/Mascot";
import { ProgressDots } from "@/components/welcome/ProgressDots";
import { PinDots } from "@/components/welcome/PinDots";
import { PinKeypad } from "@/components/welcome/PinKeypad";
import { PinSuccess } from "@/components/welcome/PinSuccess";

export const Route = createFileRoute("/welcome/pin-confirm")({
  component: ConfirmPin,
  head: () => ({ meta: [{ title: "Confirm your PIN — Turtle Bot" }] }),
});

function ConfirmPin() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [pin, setPin] = useState("");
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  useOnboardingRouteDiagnostics({ source: "confirm PIN", loading, userId: user?.id });

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/welcome" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user || pin.length !== 6 || busy) return;
    const original = sessionStorage.getItem("tb_pin_draft");
    if (!original) {
      navigate({ to: "/welcome/pin" });
      return;
    }

    if (pin !== original) {
      setShake(true);
      toast.error("Those PINs didn't match — let's try again");
      window.setTimeout(() => {
        sessionStorage.removeItem("tb_pin_draft");
        navigate({ to: "/welcome/pin" });
      }, 600);
      return;
    }

    void (async () => {
      setBusy(true);
      try {
        const hash = await hashPin(pin);
        const { error } = await supabase.from("profiles").update({ pin_hash: hash }).eq("id", user.id);
        if (error) throw error;
        sessionStorage.removeItem("tb_pin_draft");
        setVerified(true);
        recordOnboardingDiagnostic({
          route: window.location.pathname,
          source: "confirm PIN",
          status: "redirecting",
          detail: "PIN confirmed; sending to /welcome/face-id",
        });
        window.setTimeout(() => navigate({ to: "/welcome/face-id" }), 1900);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save PIN");
        setBusy(false);
        setPin("");
      }
    })();
  }, [pin, busy, navigate, user]);

  if (loading || !user) return null;
  if (verified) return <PinSuccess />;

  return (
    <div className="flex flex-1 flex-col">
      <ProgressDots step={1} total={9} />
      <div className="mt-10"><Mascot slug="rsi-divergence" /></div>
      <h1 className="mt-6 text-center font-display text-2xl font-bold tracking-tight">Confirm your PIN</h1>
      <p className="mt-2 text-center text-sm text-muted-foreground">Re-enter the six digits to confirm. Step 2 of 2.</p>
      <div className="mt-10"><PinDots filled={pin.length} shake={shake} /></div>
      <div className="mt-auto pt-10">
        <PinKeypad
          onDigit={(digit) => {
            setShake(false);
            setPin((value) => (value.length < 6 ? value + digit : value));
          }}
          onDelete={() => setPin((value) => value.slice(0, -1))}
        />
      </div>
    </div>
  );
}
