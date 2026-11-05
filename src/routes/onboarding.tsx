import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Shield, ShieldCheck, AlertTriangle, ArrowRight, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/onboarding")({
  ssr: false,
  component: Onboarding,
  head: () => ({
    meta: [
      { title: "Welcome to Turtle Bot" },
      { name: "description", content: "Set up your Turtle Bot account." },
    ],
  }),
});

type Step = "trust" | "risk" | "mode";

const STEP_KEY = "tb_onboarding_step";
const MODE_KEY = "tb_onboarding_mode";
const ACK_KEY = "tb_onboarding_ack";

function Onboarding() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [step, setStep] = useState<Step>(() => {
    if (typeof window === "undefined") return "trust";
    const saved = sessionStorage.getItem(STEP_KEY) as Step | null;
    return saved === "trust" || saved === "risk" || saved === "mode" ? saved : "trust";
  });
  const [mode, setMode] = useState<"spot" | "futures">(() => {
    if (typeof window === "undefined") return "spot";
    return (sessionStorage.getItem(MODE_KEY) as "spot" | "futures") ?? "spot";
  });
  const [acked, setAcked] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(ACK_KEY) === "1";
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => { sessionStorage.setItem(STEP_KEY, step); }, [step]);
  useEffect(() => { sessionStorage.setItem(MODE_KEY, mode); }, [mode]);
  useEffect(() => { sessionStorage.setItem(ACK_KEY, acked ? "1" : "0"); }, [acked]);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  async function finish() {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        risk_acknowledged: true,
        risk_acknowledged_at: new Date().toISOString(),
        account_mode: mode,
        onboarding_complete: true,
      })
      .eq("id", user.id);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("You're all set");
    sessionStorage.removeItem(STEP_KEY);
    sessionStorage.removeItem(MODE_KEY);
    sessionStorage.removeItem(ACK_KEY);
    navigate({ to: "/home" });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-5 pb-10 pt-12">
      <Steps step={step} />

      {step === "trust" && (
        <section className="mt-10 flex flex-1 flex-col">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/15 ring-1 ring-primary/30">
            <ShieldCheck className="h-8 w-8 text-primary" strokeWidth={2.2} />
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">
            We can trade. We can <span className="text-primary">never withdraw</span>.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Turtle Bot is non-custodial. You connect your own exchange account using API keys
            with <span className="text-foreground">withdrawals disabled</span>. The bot needs
            trade and read permission only — it trades inside your account, and your funds
            never leave it. We never hold, move, or have discretion over your money.
          </p>

          <ul className="mt-6 space-y-3">
            {[
              "Your exchange. Your funds. Always.",
              "API keys are trade + read only. No withdrawal scope.",
              "Secrets are encrypted server-side and never sent back to the app.",
            ].map((t) => (
              <li key={t} className="flex items-start gap-3 rounded-xl bg-surface p-3.5 text-sm">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span className="text-foreground/90">{t}</span>
              </li>
            ))}
          </ul>

          <button
            onClick={() => setStep("risk")}
            className="mt-auto flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground"
          >
            Got it <ArrowRight className="h-4 w-4" />
          </button>
        </section>
      )}

      {step === "risk" && (
        <section className="mt-10 flex flex-1 flex-col">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gold/15 ring-1 ring-gold/30">
            <AlertTriangle className="h-8 w-8 text-gold" strokeWidth={2.2} />
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">A real risk disclaimer</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Trading involves real risk of loss. Past performance and backtested results do not
            guarantee future returns. Turtle Bot makes no promises about profit. You may lose
            some or all of the capital you allocate to the bot.
          </p>

          <div className="mt-6 rounded-xl border border-border bg-surface p-4">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Your guardrails</h2>
            <p className="mt-2 text-sm leading-relaxed text-foreground/90">
              You start in <span className="font-semibold text-foreground">demo mode</span> with
              simulated balances. No real money moves until you explicitly connect a live
              exchange and switch off demo mode.
            </p>
          </div>

          <label className="mt-6 flex items-start gap-3 rounded-xl bg-inset p-4 text-sm">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[--color-primary]"
            />
            <span className="text-foreground/90">
              I understand the risks and that no returns are promised.
            </span>
          </label>

          <button
            disabled={!acked}
            onClick={() => setStep("mode")}
            className="mt-auto flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-40"
          >
            Continue <ArrowRight className="h-4 w-4" />
          </button>
        </section>
      )}

      {step === "mode" && (
        <section className="mt-10 flex flex-1 flex-col">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/15 ring-1 ring-primary/30">
            <Shield className="h-8 w-8 text-primary" strokeWidth={2.2} />
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">Pick your starting market</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            You can change this later. Spot is safer — no leverage, no liquidation.
          </p>

          <div className="mt-6 grid gap-3">
            <ModeCard
              title="Spot"
              subtitle="Recommended for new users"
              body="Trade the asset directly. No leverage, no liquidation. Four strategies available."
              selected={mode === "spot"}
              onSelect={() => setMode("spot")}
            />
            <ModeCard
              title="Futures"
              subtitle="Advanced"
              body="Leverage, cross-margin and liquidation risk apply. All six strategies unlocked."
              selected={mode === "futures"}
              onSelect={() => setMode("futures")}
            />
          </div>

          <button
            onClick={finish}
            disabled={saving}
            className="mt-auto flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            Enter Turtle Bot
          </button>
        </section>
      )}
    </main>
  );
}

function Steps({ step }: { step: Step }) {
  const order: Step[] = ["trust", "risk", "mode"];
  const idx = order.indexOf(step);
  return (
    <div className="flex items-center gap-2">
      {order.map((s, i) => (
        <div
          key={s}
          className={`h-1.5 flex-1 rounded-full transition ${
            i <= idx ? "bg-primary" : "bg-border"
          }`}
        />
      ))}
    </div>
  );
}

function ModeCard({
  title, subtitle, body, selected, onSelect,
}: { title: string; subtitle: string; body: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`rounded-xl border p-4 text-left transition ${
        selected
          ? "border-primary/60 bg-primary/10 ring-2 ring-primary/30"
          : "border-border bg-surface hover:bg-inset"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">{title}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{subtitle}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{body}</p>
    </button>
  );
}
