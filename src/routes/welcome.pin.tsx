import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useOnboardingRouteDiagnostics } from "@/lib/onboarding-diagnostics";
import { Mascot } from "@/components/welcome/Mascot";
import { ProgressDots } from "@/components/welcome/ProgressDots";
import { PinDots } from "@/components/welcome/PinDots";
import { PinKeypad } from "@/components/welcome/PinKeypad";

export const Route = createFileRoute("/welcome/pin")({
  component: CreatePin,
  head: () => ({ meta: [{ title: "Create your PIN — Turtle Bot" }] }),
});

function CreatePin() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [pin, setPin] = useState("");
  useOnboardingRouteDiagnostics({ source: "create PIN", loading, userId: user?.id });

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/welcome" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    if (pin.length === 6) {
      sessionStorage.setItem("tb_pin_draft", pin);
      navigate({ to: "/welcome/pin-confirm" });
    }
  }, [pin, navigate, user]);

  if (loading || !user) return null;


  return (
    <div className="flex flex-1 flex-col">
      <ProgressDots step={1} total={9} />
      <div className="mt-10">
        <Mascot slug="dca" />
      </div>
      <h1 className="mt-6 text-center font-display text-2xl font-bold tracking-tight">
        Create your PIN
      </h1>
      <p className="mt-2 text-center text-sm text-muted-foreground">
        Pick 6 digits. You'll use this to unlock the app.
      </p>

      <div className="mt-10">
        <PinDots filled={pin.length} />
      </div>

      <div className="mt-auto pt-10">
        <PinKeypad
          onDigit={(d) => setPin((p) => (p.length < 6 ? p + d : p))}
          onDelete={() => setPin((p) => p.slice(0, -1))}
        />
      </div>
    </div>
  );
}
