/**
 * FusionProductSection — premium full-width product surface at the bottom of
 * Life Map. This is a PRODUCT PREVIEW, NOT a bot. It:
 *   • never trades, never simulates, never toggles on/off
 *   • never appears in the operational strategy grid
 *   • never grants access or takes payment
 *
 * The primary action opens a real qualification form (drawer) that writes a
 * tenant-owned lead to `public.fusion_lead_requests` via RLS.
 */
import { useMemo, useState } from "react";
import { Radar, Layers3, Brain, ShieldCheck, ArrowRight, Loader2 } from "lucide-react";
import fusionArt from "@/assets/characters/fusion.png.asset.json";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

const FUSION_ACCENT = "#7C5CFF";
const SCOUT_ACCENT = "#4FD1C5";

// Two-year claim: no verified provenance constant exists in the repo, so we
// deliberately use the truthful alternative and DO NOT print "two years".
const HERITAGE_COPY = "Built on Onyx's accumulated intelligence";

export function FusionProductSection() {
  const [open, setOpen] = useState(false);

  return (
    <section
      aria-labelledby="fusion-product-heading"
      className="relative overflow-hidden rounded-2xl border"
      style={{
        borderColor: `color-mix(in oklab, ${FUSION_ACCENT} 35%, transparent)`,
        background:
          "radial-gradient(120% 90% at 100% 0%, rgba(124,92,255,0.18), transparent 55%), radial-gradient(90% 70% at 0% 100%, rgba(79,209,197,0.10), transparent 60%), linear-gradient(180deg, rgba(10,12,20,0.85), rgba(10,12,20,0.95))",
      }}
    >
      <div className="grid gap-0 md:grid-cols-[minmax(260px,42%)_1fr]">
        {/* Left: art */}
        <div
          className="relative min-h-[260px] overflow-hidden md:min-h-[420px]"
          aria-hidden
        >
          <img
            src={fusionArt.url}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: "center 30%" }}
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(90deg, rgba(10,12,20,0) 40%, rgba(10,12,20,0.9) 100%), linear-gradient(180deg, rgba(10,12,20,0.15), rgba(10,12,20,0.55))",
            }}
          />
          <div className="absolute left-4 top-4 flex items-center gap-2">
            <span
              className="rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur-sm"
              style={{
                color: FUSION_ACCENT,
                borderColor: `color-mix(in oklab, ${FUSION_ACCENT} 55%, transparent)`,
                background: `color-mix(in oklab, ${FUSION_ACCENT} 15%, transparent)`,
              }}
            >
              Custom Build
            </span>
            <span
              className="rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur-sm"
              style={{
                color: SCOUT_ACCENT,
                borderColor: `color-mix(in oklab, ${SCOUT_ACCENT} 55%, transparent)`,
                background: `color-mix(in oklab, ${SCOUT_ACCENT} 12%, transparent)`,
              }}
            >
              Scout Included
            </span>
          </div>
        </div>

        {/* Right: content */}
        <div className="flex flex-col gap-4 p-5 md:p-7">
          <div>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.24em] text-white/50">
              Product · Not a bot
            </p>
            <h2
              id="fusion-product-heading"
              className="mt-1 font-display text-[26px] font-semibold leading-tight text-white sm:text-[30px]"
            >
              Fusion <span style={{ color: FUSION_ACCENT }}>+</span> Scout
            </h2>
            <p
              className="mt-1 font-display text-[13.5px] font-medium"
              style={{ color: `color-mix(in oklab, ${FUSION_ACCENT} 65%, white)` }}
            >
              Custom-built for professional traders
            </p>
          </div>

          <p className="max-w-[62ch] text-[13.5px] leading-relaxed text-white/70">
            <b className="text-white">Scout</b> scans your authorized markets and calls
            structured signals. <b className="text-white">Fusion</b> coordinates approved
            strategy formations around your constraints, symbols, venues and workflow.
            {" "}<b className="text-white">Onyx</b> supplies accumulated decision
            intelligence. Delivered as a configured system for your desk — not a
            self-serve retail bot.
          </p>

          <div className="grid gap-2.5 sm:grid-cols-3">
            <Pillar
              icon={<Radar className="h-4 w-4" />}
              title="Scout Signal Network"
              body="Structural signal feed tuned to your markets and timeframes."
              accent={SCOUT_ACCENT}
            />
            <Pillar
              icon={<Layers3 className="h-4 w-4" />}
              title="Adaptive Formation Design"
              body="Approved strategy formations composed for your risk envelope."
              accent={FUSION_ACCENT}
            />
            <Pillar
              icon={<Brain className="h-4 w-4" />}
              title="Onyx Intelligence"
              body={HERITAGE_COPY + "."}
              accent="#3B82F6"
            />
          </div>

          <div
            className="mt-1 flex flex-wrap items-end justify-between gap-4 rounded-xl border px-4 py-3"
            style={{
              borderColor: `color-mix(in oklab, ${FUSION_ACCENT} 35%, transparent)`,
              background: `color-mix(in oklab, ${FUSION_ACCENT} 8%, transparent)`,
            }}
          >
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/55">
                Starting at
              </p>
              <p className="mt-0.5 font-display text-[24px] font-semibold tabular-nums text-white">
                $3,000
                <span className="ml-2 align-middle font-mono text-[10.5px] uppercase tracking-[0.18em] text-white/50">
                  · custom build · scope dependent
                </span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="#fusion-overview"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 px-3.5 py-2 text-[12px] font-medium text-white/80 transition hover:bg-white/5"
              >
                Product overview
              </a>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white shadow-[0_8px_24px_-8px_rgba(124,92,255,0.6)] transition hover:brightness-110"
                style={{
                  background: `linear-gradient(135deg, ${FUSION_ACCENT}, #5B3AE0)`,
                }}
              >
                Configure My Build <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <p
            id="fusion-overview"
            className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/50"
          >
            <ShieldCheck className="h-3 w-3" style={{ color: FUSION_ACCENT }} />
            Custom deployment · No guaranteed returns · Not available as a retail bot
          </p>
        </div>
      </div>

      <FusionQualifySheet open={open} onClose={() => setOpen(false)} />
    </section>
  );
}

function Pillar({
  icon,
  title,
  body,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
      <div
        className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em]"
        style={{ color: accent }}
      >
        {icon}
        {title}
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-white/70">{body}</p>
    </div>
  );
}

/* ------------------------ Qualification sheet ------------------------ */

interface LeadForm {
  contact_name: string;
  contact_email: string;
  company: string;
  target_venues: string;
  symbols: string;
  timeframes: string;
  delivery_needs: string;
  risk_limits: string;
  automation_level: string;
  notes: string;
}

const EMPTY_FORM: LeadForm = {
  contact_name: "",
  contact_email: "",
  company: "",
  target_venues: "",
  symbols: "",
  timeframes: "",
  delivery_needs: "",
  risk_limits: "",
  automation_level: "",
  notes: "",
};

async function hashSubmission(form: LeadForm): Promise<string> {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, (v ?? "").trim().toLowerCase()]),
    ),
  );
  const buf = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function FusionQualifySheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [form, setForm] = useState<LeadForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const canSubmit = useMemo(() => {
    return (
      form.contact_name.trim().length > 0 &&
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.contact_email.trim())
    );
  }, [form.contact_name, form.contact_email]);

  async function submit() {
    if (!user) {
      toast.error("Sign in required to submit a request.");
      return;
    }
    if (!canSubmit) return;
    setSaving(true);
    try {
      const submission_hash = await hashSubmission(form);
      const { error } = await supabase
        .from("fusion_lead_requests")
        .insert({
          user_id: user.id,
          contact_name: form.contact_name.trim(),
          contact_email: form.contact_email.trim(),
          company: nullable(form.company),
          target_venues: nullable(form.target_venues),
          symbols: nullable(form.symbols),
          timeframes: nullable(form.timeframes),
          delivery_needs: nullable(form.delivery_needs),
          risk_limits: nullable(form.risk_limits),
          automation_level: nullable(form.automation_level),
          notes: nullable(form.notes),
          submission_hash,
          status: "submitted",
        });
      if (error) {
        if (
          error.code === "23505" ||
          error.message.includes("fusion_lead_requests_idem")
        ) {
          toast.info("We already have this request. We'll be in touch.");
          setDone(true);
        } else if (error.message.includes("rate_limited")) {
          toast.error("Too many requests in the last hour. Please try again later.");
        } else {
          toast.error(error.message);
        }
        return;
      }
      setDone(true);
      toast.success("Request received. The team will reach out.");
    } finally {
      setSaving(false);
    }
  }

  function close() {
    onClose();
    // Small delay so the user sees the confirmation before the form resets.
    setTimeout(() => {
      setForm(EMPTY_FORM);
      setDone(false);
    }, 250);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <SheetContent
        side="right"
        className="w-full max-w-[520px] overflow-y-auto border-l border-white/10 bg-[#0A0B10] text-white"
      >
        <SheetTitle className="font-display text-[20px] font-semibold text-white">
          Configure your Fusion build
        </SheetTitle>
        <SheetDescription className="mt-1 text-[12.5px] text-white/60">
          Tell us the shape of the desk. We'll come back with scope, timeline and
          a fixed proposal. No trading access is granted from this form.
        </SheetDescription>

        {done ? (
          <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[14px] font-semibold text-white">Request received</p>
            <p className="mt-1 text-[12.5px] text-white/60">
              We'll email {form.contact_email || "you"} to schedule a scoping call.
              You can safely close this panel.
            </p>
            <button
              type="button"
              onClick={close}
              className="mt-4 inline-flex rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/80 hover:bg-white/5"
            >
              Close
            </button>
          </div>
        ) : (
          <form
            className="mt-5 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Row label="Your name *">
              <Input value={form.contact_name} onChange={(v) => set(form, setForm, "contact_name", v)} required />
            </Row>
            <Row label="Work email *">
              <Input type="email" value={form.contact_email} onChange={(v) => set(form, setForm, "contact_email", v)} required />
            </Row>
            <Row label="Company / desk">
              <Input value={form.company} onChange={(v) => set(form, setForm, "company", v)} />
            </Row>
            <Row label="Target venues" hint="e.g. ApeX Omni, Binance, Hyperliquid">
              <Input value={form.target_venues} onChange={(v) => set(form, setForm, "target_venues", v)} />
            </Row>
            <Row label="Symbols" hint="e.g. BTC, ETH, SOL perps">
              <Input value={form.symbols} onChange={(v) => set(form, setForm, "symbols", v)} />
            </Row>
            <Row label="Timeframes" hint="e.g. 5m execution / 1h context">
              <Input value={form.timeframes} onChange={(v) => set(form, setForm, "timeframes", v)} />
            </Row>
            <Row label="Delivery needs" hint="Dashboards, alerts, API webhooks…">
              <Input value={form.delivery_needs} onChange={(v) => set(form, setForm, "delivery_needs", v)} />
            </Row>
            <Row label="Risk limits" hint="Max drawdown, per-trade risk, leverage caps">
              <Input value={form.risk_limits} onChange={(v) => set(form, setForm, "risk_limits", v)} />
            </Row>
            <Row label="Desired automation level" hint="Recommendations · Assisted · Autonomous with approvals">
              <Input value={form.automation_level} onChange={(v) => set(form, setForm, "automation_level", v)} />
            </Row>
            <Row label="Notes">
              <textarea
                value={form.notes}
                onChange={(e) => set(form, setForm, "notes", e.target.value)}
                rows={4}
                className="w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-white outline-none focus:border-white/25"
              />
            </Row>

            <p className="pt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
              Submitting creates a request record only. No entitlements or trading
              access are granted.
            </p>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={close}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-white/70 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit || saving}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
                style={{
                  background: `linear-gradient(135deg, ${FUSION_ACCENT}, #5B3AE0)`,
                }}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Submit request
              </button>
            </div>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}

function nullable(v: string): string | null {
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function set<K extends keyof LeadForm>(
  form: LeadForm,
  setForm: (f: LeadForm) => void,
  key: K,
  value: LeadForm[K],
) {
  setForm({ ...form, [key]: value });
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/55">
        {label}
        {hint && <span className="ml-2 normal-case tracking-normal text-white/40">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Input(props: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <input
      type={props.type ?? "text"}
      value={props.value}
      required={props.required}
      onChange={(e) => props.onChange(e.target.value)}
      className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-white outline-none focus:border-white/25"
    />
  );
}
