import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Link2, Eye, EyeOff, Check, ChevronDown, Building2, Boxes, ArrowLeft, Lock } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  recordOnboardingDiagnostic,
  useOnboardingRouteDiagnostics,
} from "@/lib/onboarding-diagnostics";
import { Mascot } from "@/components/welcome/Mascot";
import { ProgressDots } from "@/components/welcome/ProgressDots";
import {
  SUPPORTED_CEX,
  SUPPORTED_DEX,
  isSupportedVenue,
  type SupportedVenue,
  type VenueKind,
} from "@/lib/supported-exchanges";

export const Route = createFileRoute("/welcome/exchange")({
  component: ExchangeStep,
  head: () => ({ meta: [{ title: "Connect exchange — Turtle Bot" }] }),
});

const VENUE_LABELS: Record<SupportedVenue, string> = {
  coinbase: "Coinbase",
  kraken: "Kraken",
  apex_omni: "ApeX Omni",
  aster: "Aster",
  synfutures: "SynFutures",
};

// Venues that require a passphrase in addition to key + secret.
const VENUES_WITH_PASSPHRASE = new Set<SupportedVenue>(["apex_omni"]);

// Venues whose adapter is scaffolded but the live API/signing flow is not
// yet wired. UI shows them but blocks credential submission until the
// integration lands. Kept in `supported-exchanges.ts` so the backend
// allowlist and UI stay in sync.
const PENDING_VENUES = new Set<SupportedVenue>([
  "coinbase",
  "aster",
  "synfutures",
]);

type Step = "kind" | "venue" | "credentials";

// Credentials are never encoded or stored client-side. The `exchange-credentials`
// edge function encrypts them server-side with AES-256-GCM before persisting.

function ExchangeStep() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  useOnboardingRouteDiagnostics({ source: "exchange", loading, userId: user?.id });

  const [step, setStep] = useState<Step>("kind");
  const [kind, setKind] = useState<VenueKind | null>(null);
  const [venue, setVenue] = useState<SupportedVenue | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-custodial guarantee: TurtleBot only accepts TRADE-ONLY API keys.
  // The user must attest that their newly-created key has withdrawals
  // disabled. This is stored alongside the connection and mirrored to the
  // signer's credential-scope guard. See docs/ONBOARDING_SECURITY.md §8.
  const [withdrawalsDisabled, setWithdrawalsDisabled] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/welcome" });
  }, [loading, user, navigate]);

  const venuesForKind: SupportedVenue[] =
    kind === "cex" ? [...SUPPORTED_CEX] : kind === "dex" ? [...SUPPORTED_DEX] : [];
  const needsPassphrase = venue ? VENUES_WITH_PASSPHRASE.has(venue) : false;

  const canSubmit =
    apiKey.trim().length > 4 &&
    apiSecret.trim().length > 4 &&
    (!needsPassphrase || passphrase.trim().length > 0) &&
    withdrawalsDisabled &&
    !submitting;

  function chooseKind(k: VenueKind) {
    setKind(k);
    const pool = k === "cex" ? SUPPORTED_CEX : SUPPORTED_DEX;
    const firstLive = pool.find((v) => !PENDING_VENUES.has(v)) ?? pool[0];
    setVenue(firstLive);
    setStep("venue");
  }

  function chooseVenue(v: SupportedVenue) {
    if (!isSupportedVenue(v)) return;
    if (PENDING_VENUES.has(v)) return; // pending venues are not selectable
    setVenue(v);
    setPickerOpen(false);
    setStep("credentials");
  }

  function backTo(target: Step) {
    setError(null);
    setPickerOpen(false);
    setStep(target);
  }

  async function save() {
    if (!user || !canSubmit || !venue) return;
    if (!isSupportedVenue(venue)) {
      setError("Unsupported exchange.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const keyPlain = apiKey.trim();
    const secretPlain = apiSecret.trim();
    const passPlain = needsPassphrase ? passphrase.trim() : "";
    // Wipe local state immediately so the values don't linger in the DOM.
    setApiKey("");
    setApiSecret("");
    setPassphrase("");
    const { data, error: fnError } = await supabase.functions.invoke("exchange-credentials", {
      body: {
        action: "connect",
        exchange: venue,
        api_key: keyPlain,
        api_secret: secretPlain,
        ...(passPlain ? { passphrase: passPlain } : {}),
        // Non-custodial: user attests that the key has withdrawals disabled.
        // Server stores this on the connection and (where the venue exposes
        // key permissions) cross-checks against the venue during verify.
        withdrawals_disabled_attestation: withdrawalsDisabled,
      },
    });
    if (fnError || !data?.ok) {
      setError((data as { message?: string } | null)?.message ?? "Could not save credentials.");
      setSubmitting(false);
      return;
    }

    const connectionId = (data as { connection_id?: string }).connection_id;
    if (!connectionId) {
      setError("Credentials were saved, but the connection identifier was missing. Please try again.");
      setSubmitting(false);
      return;
    }
    const { data: verification, error: verificationError } = await supabase.functions.invoke(
      "exchange-credentials",
      { body: { action: "test", connection_id: connectionId } },
    );
    if (verificationError || !verification?.ok) {
      setError(
        (verification as { message?: string } | null)?.message ??
          "Credentials were saved securely, but Kraken could not verify this key.",
      );
      setSubmitting(false);
      return;
    }

    recordOnboardingDiagnostic({
      route: window.location.pathname,
      source: "exchange guard",
      status: "redirecting",
      detail: `Verified ${venue}; sending to /welcome/wallet`,
    });
    navigate({ to: "/welcome/wallet" });
  }

  function skip() {
    recordOnboardingDiagnostic({
      route: window.location.pathname,
      source: "exchange guard",
      status: "redirecting",
      detail: "Skipped; sending to /welcome/wallet",
    });
    navigate({ to: "/welcome/wallet" });
  }

  return (
    <div className="flex flex-1 flex-col">
      <ProgressDots step={3} total={9} />
      <div className="mt-8">
        <Mascot slug="break-retest" />
      </div>
      <div className="mt-6 flex items-center justify-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05]">
          <Link2 className="h-6 w-6 text-primary" />
        </div>
      </div>

      {step === "kind" && <KindStep onChoose={chooseKind} onSkip={skip} />}

      {step === "venue" && kind && (
        <VenueStep
          kind={kind}
          venues={venuesForKind}
          selected={venue}
          onBack={() => backTo("kind")}
          onSelect={chooseVenue}
        />
      )}

      {step === "credentials" && venue && (
        <>
          <div className="mt-5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => backTo("venue")}
              className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {kind === "cex" ? "Centralized" : "Decentralized"}
            </span>
          </div>
          <h1 className="mt-3 text-center font-display text-2xl font-bold tracking-tight">
            Connect {VENUE_LABELS[venue]}
          </h1>
          <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
            {venue === "kraken"
              ? "Use a Kraken Spot API key with Query Funds enabled and every withdrawal permission disabled. Live execution remains unavailable."
              : "Connect for account verification and read-only monitoring. Live execution is unavailable pending jurisdiction and licensing approval. Withdrawals stay disabled — always."}
          </p>

          <div className="mt-6 flex flex-col gap-3">
            {/* Venue quick picker (still within same kind) */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="flex h-12 w-full items-center justify-between rounded-[18px] border border-white/10 bg-white/[0.05] px-4 text-left text-sm font-medium text-foreground active:scale-[0.99]"
              >
                <span className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Exchange
                  </span>
                  <span className="font-semibold">{VENUE_LABELS[venue]}</span>
                </span>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${pickerOpen ? "rotate-180" : ""}`} />
              </button>
              {pickerOpen && (
                <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-[18px] border border-white/10 bg-[#0A0B10]/95 p-1.5 backdrop-blur-xl shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)]">
                  {venuesForKind.map((v) => {
                    const active = v === venue;
                    const pending = PENDING_VENUES.has(v);
                    if (pending) {
                      return (
                        <div
                          key={v}
                          aria-disabled
                          className="flex h-10 w-full cursor-not-allowed items-center justify-between rounded-xl px-3 text-sm text-muted-foreground/60"
                        >
                          <span className="font-medium">{VENUE_LABELS[v]}</span>
                          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider">
                            <Lock className="h-3 w-3" /> Coming soon
                          </span>
                        </div>
                      );
                    }
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          setVenue(v);
                          setPickerOpen(false);
                        }}
                        className={`flex h-10 w-full items-center justify-between rounded-xl px-3 text-sm ${
                          active
                            ? "bg-primary/[0.08] text-foreground"
                            : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                        }`}
                      >
                        <span className="font-medium">{VENUE_LABELS[v]}</span>
                        {active && <Check className="h-4 w-4 text-primary" strokeWidth={2.5} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <SecretField
              label="API Key"
              value={apiKey}
              onChange={setApiKey}
              show={showKey}
              onToggle={() => setShowKey((v) => !v)}
              placeholder="Paste your API key"
            />
            <SecretField
              label="API Secret"
              value={apiSecret}
              onChange={setApiSecret}
              show={showSecret}
              onToggle={() => setShowSecret((v) => !v)}
              placeholder="Paste your API secret"
            />
            {needsPassphrase && (
              <SecretField
                label="Passphrase"
                value={passphrase}
                onChange={setPassphrase}
                show={showPass}
                onToggle={() => setShowPass((v) => !v)}
                placeholder="Paste your passphrase"
              />
            )}

            {/* Non-custodial: TRADE-ONLY key requirement + user attestation. */}
            <div className="rounded-[18px] border border-primary/20 bg-primary/[0.04] p-3.5 text-xs leading-relaxed text-muted-foreground">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                Trade-only key required
              </div>
              <p>
                Turtle Bot is <strong className="text-foreground">non-custodial</strong>. Your key
                must have <strong className="text-foreground">Withdrawals DISABLED</strong>. Read + Trade
                only. On ApeX Omni: <em>API Management → Create Key → uncheck "Withdraw"</em>. If
                the venue exposes key scopes we verify server-side and reject withdrawal-capable
                keys; the attestation below is required either way.
              </p>
              <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-foreground">
                <input
                  type="checkbox"
                  checked={withdrawalsDisabled}
                  onChange={(e) => setWithdrawalsDisabled(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-white/20 bg-white/[0.06] accent-primary"
                />
                <span className="text-xs">
                  I confirm this API key has <strong>withdrawals disabled</strong>.
                </span>
              </label>
            </div>

            {error && (
              <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>

          <div className="mt-auto flex flex-col gap-2.5 pt-8">
            <button
              onClick={save}
              disabled={!canSubmit}
              className="welcome-primary-action flex h-14 items-center justify-center text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Connecting…" : "Connect"}
            </button>
            <button
              onClick={skip}
              className="welcome-secondary-action flex h-14 items-center justify-center text-sm font-medium text-foreground"
            >
              Skip for now
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function KindStep({ onChoose, onSkip }: { onChoose: (k: VenueKind) => void; onSkip: () => void }) {
  return (
    <>
      <h1 className="mt-5 text-center font-display text-2xl font-bold tracking-tight">
        Connect Exchange
      </h1>
      <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
        Pick the kind of venue. You can add more later.
      </p>

      <div className="mt-7 flex flex-col gap-3">
        <KindCard
          icon={<Building2 className="h-5 w-5 text-primary" />}
          title="Centralized Exchange"
          subtitle="CEX · API key + secret"
          onClick={() => onChoose("cex")}
        />
        <KindCard
          icon={<Boxes className="h-5 w-5 text-primary" />}
          title="Decentralized Exchange"
          subtitle="DEX · API credentials"
          onClick={() => onChoose("dex")}
        />
      </div>

      <div className="mt-auto pt-8">
        <button
          onClick={onSkip}
          className="welcome-secondary-action flex h-14 w-full items-center justify-center text-sm font-medium text-foreground"
        >
          Skip for now
        </button>
      </div>
    </>
  );
}

function KindCard({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/[0.05] px-4 py-3.5 text-left transition-[transform,background] active:scale-[0.99] hover:bg-white/[0.07]"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/25">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{subtitle}</div>
      </div>
      <ChevronDown className="h-4 w-4 -rotate-90 text-muted-foreground" />
    </button>
  );
}

function VenueStep({
  kind,
  venues,
  selected,
  onBack,
  onSelect,
}: {
  kind: VenueKind;
  venues: SupportedVenue[];
  selected: SupportedVenue | null;
  onBack: () => void;
  onSelect: (v: SupportedVenue) => void;
}) {
  return (
    <>
      <div className="mt-5 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {kind === "cex" ? "Centralized" : "Decentralized"}
        </span>
      </div>
      <h1 className="mt-3 text-center font-display text-2xl font-bold tracking-tight">
        Choose your {kind === "cex" ? "exchange" : "venue"}
      </h1>
      <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
        Only verified integrations are shown. Coming-soon venues can't be selected yet.
      </p>

      <div className="mt-6 flex flex-col gap-2.5">
        {venues.map((v) => {
          const active = v === selected;
          const pending = PENDING_VENUES.has(v);
          if (pending) {
            return (
              <div
                key={v}
                aria-disabled
                className="flex h-14 cursor-not-allowed items-center justify-between rounded-[18px] border border-white/5 bg-white/[0.02] px-4 text-left text-sm font-semibold text-muted-foreground/70"
              >
                <span>{VENUE_LABELS[v]}</span>
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider">
                  <Lock className="h-3 w-3" /> Coming soon
                </span>
              </div>
            );
          }
          return (
            <button
              key={v}
              type="button"
              onClick={() => onSelect(v)}
              className={`flex h-14 items-center justify-between rounded-[18px] border px-4 text-left text-sm font-semibold text-foreground active:scale-[0.99] ${
                active
                  ? "border-primary/40 bg-primary/[0.08]"
                  : "border-white/10 bg-white/[0.05] hover:bg-white/[0.07]"
              }`}
            >
              <span>{VENUE_LABELS[v]}</span>
              <Check className={`h-4 w-4 ${active ? "text-primary" : "text-transparent"}`} strokeWidth={2.5} />
            </button>
          );
        })}
      </div>
    </>
  );
}


function SecretField({
  label,
  value,
  onChange,
  show,
  onToggle,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
  placeholder: string;
}) {
  return (
    <div className="rounded-[18px] border border-white/10 bg-white/[0.05] px-4 py-2.5 transition-[border-color,background] duration-300 ease-[cubic-bezier(.22,1,.36,1)] focus-within:border-primary/30 focus-within:bg-white/[0.06]">
      <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 bg-transparent text-sm font-medium text-foreground tabular-nums placeholder:text-muted-foreground/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={onToggle}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          aria-label={show ? "Hide" : "Show"}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
