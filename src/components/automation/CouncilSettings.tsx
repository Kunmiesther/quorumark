import { useEffect, useMemo, useState } from "react";
import { Check, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";

type Provider = "openai" | "anthropic" | "google";
type Seat = { provider: Provider; model: string };

const PROVIDERS: Array<{
  id: Provider;
  name: string;
  logo: string;
  models: Array<{ id: string; name: string }>;
}> = [
  {
    id: "openai",
    name: "OpenAI",
    logo: "/brand/openai.svg",
    models: [
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    logo: "/brand/anthropic.svg",
    models: [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "google",
    name: "Google",
    logo: "/brand/google-gemini.svg",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
];

export function CouncilSettings() {
  const [enabled, setEnabled] = useState(false);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [connected, setConnected] = useState<Partial<Record<Provider, string>>>({});
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [visible, setVisible] = useState<Partial<Record<Provider, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [consented, setConsented] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("llm-credentials", {
      body: { action: "summary" },
    });
    setLoading(false);
    if (error || !data?.ok)
      return toast.error(data?.message ?? "Could not load AI Council settings.");
    const next: Partial<Record<Provider, string>> = {};
    for (const row of data.providers ?? []) next[row.provider as Provider] = row.key_last_four;
    setConnected(next);
    setConsented(Boolean(data.ai_consent?.granted));
    setEnabled(Boolean(data.council?.enabled));
    setSeats(Array.isArray(data.council?.seats) ? data.council.seats : []);
  }

  useEffect(() => {
    void load();
  }, []);
  const missingKeys = useMemo(
    () => seats.filter((seat) => !connected[seat.provider] && !keys[seat.provider]?.trim()),
    [seats, connected, keys],
  );
  const connectedCount = Object.keys(connected).length;

  function toggleProvider(provider: Provider) {
    setSeats((current) => {
      if (current.some((seat) => seat.provider === provider))
        return current.filter((seat) => seat.provider !== provider);
      if (current.length >= 3) return current;
      const spec = PROVIDERS.find((item) => item.id === provider)!;
      return [...current, { provider, model: spec.models[0].id }];
    });
  }

  async function save() {
    if (!consented)
      return toast.error("Enable AI data sharing in Profile before connecting Council providers.");
    if (enabled && seats.length !== 3)
      return toast.error("Choose all three Council seats for independent review.");
    if (enabled && missingKeys.length)
      return toast.error("Connect an API key for each enabled Council seat.");
    setSaving(true);
    for (const seat of seats) {
      const apiKey = keys[seat.provider]?.trim();
      if (!apiKey) continue;
      const { data, error } = await supabase.functions.invoke("llm-credentials", {
        body: { action: "save", provider: seat.provider, api_key: apiKey },
      });
      if (error || !data?.ok) {
        setSaving(false);
        return toast.error(data?.message ?? `Could not connect ${seat.provider}.`);
      }
    }
    const { data, error } = await supabase.functions.invoke("llm-credentials", {
      body: { action: "save_council", enabled, seats },
    });
    setSaving(false);
    if (error || !data?.ok)
      return toast.error(data?.message ?? "Could not save AI Council settings.");
    setKeys({});
    toast.success("AI Council saved. Revalidate strategies before live use.");
    await load();
  }

  if (loading)
    return (
      <div className="tb-neu-panel mt-5 grid min-h-40 place-items-center rounded-[28px]">
        <Loader2 className="h-5 w-5 animate-spin text-violet-300" />
      </div>
    );

  return (
    <section className="tb-neu-panel mt-5 rounded-[28px] p-4" aria-labelledby="council-heading">
      <div className="flex items-start gap-3">
        <span className="tb-neu-raised grid h-11 w-11 shrink-0 place-items-center rounded-full text-violet-300">
          <Users className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="council-heading" className="font-display text-lg">
            AI Council
          </h2>
          <p className="mt-1 text-xs leading-5 text-white/45">
            Choose three independent models: lead thesis, risk officer, then market structure. Onyx
            requires their confirmation; deterministic rules still create and size every trade.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((value) => !value)}
          className={`relative h-8 w-14 shrink-0 rounded-full border transition ${enabled ? "border-violet-400/60 bg-violet-500/25" : "border-white/10 bg-black/30"}`}
        >
          <span
            className={`absolute top-1 h-6 w-6 rounded-full bg-white transition ${enabled ? "left-7" : "left-1"}`}
          />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between rounded-2xl bg-white/[0.025] px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-white/45">
        <span>{seats.length}/3 seats selected</span>
        <span
          className={
            enabled && seats.length > 0 && missingKeys.length === 0
              ? "text-emerald-300"
              : "text-white/45"
          }
        >
          {enabled && seats.length > 0 && missingKeys.length === 0
            ? "Ready"
            : `${connectedCount} keys connected`}
        </span>
      </div>
      <div className="mt-4 space-y-3">
        {PROVIDERS.map((provider) => {
          const seat = seats.find((item) => item.provider === provider.id);
          const seatIndex = seats.findIndex((item) => item.provider === provider.id);
          return (
            <article
              key={provider.id}
              className={`tb-neu-inset rounded-2xl p-3 ${seat ? "ring-1 ring-violet-400/50" : ""}`}
            >
              <button
                type="button"
                onClick={() => toggleProvider(provider.id)}
                className="flex w-full items-center gap-3 text-left"
              >
                <span className="tb-neu-raised grid h-11 w-11 place-items-center overflow-hidden rounded-full">
                  <img src={provider.logo} alt="" className="h-7 w-7 object-contain" />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm">{provider.name}</strong>
                  <span className="text-[10px] text-white/40">
                    {seatIndex >= 0
                      ? `${["Lead thesis", "Risk officer", "Market structure"][seatIndex]} · `
                      : ""}
                    {connected[provider.id]
                      ? `Connected •••• ${connected[provider.id]}`
                      : "API key required"}
                  </span>
                </span>
                <span
                  className={`grid h-7 w-7 place-items-center rounded-full border ${seat ? "border-violet-400 text-violet-300" : "border-white/15"}`}
                >
                  {seat ? <Check className="h-4 w-4" /> : null}
                </span>
              </button>
              {seat ? (
                <div className="mt-3 space-y-2 border-t border-white/[0.06] pt-3">
                  <select
                    value={seat.model}
                    onChange={(event) =>
                      setSeats((current) =>
                        current.map((item) =>
                          item.provider === provider.id
                            ? { ...item, model: event.target.value }
                            : item,
                        ),
                      )
                    }
                    className="h-10 w-full rounded-xl border border-white/10 bg-[#11121a] px-3 text-xs text-white outline-none"
                  >
                    {provider.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <div className="flex h-10 items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3">
                    <KeyRound className="h-4 w-4 text-violet-300" />
                    <input
                      type={visible[provider.id] ? "text" : "password"}
                      value={keys[provider.id] ?? ""}
                      onChange={(event) =>
                        setKeys((current) => ({ ...current, [provider.id]: event.target.value }))
                      }
                      placeholder={
                        connected[provider.id]
                          ? "Enter a new key to replace it"
                          : `Add ${provider.name} API key`
                      }
                      autoComplete="new-password"
                      spellCheck={false}
                      className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setVisible((current) => ({
                          ...current,
                          [provider.id]: !current[provider.id],
                        }))
                      }
                      aria-label={visible[provider.id] ? "Hide API key" : "Show API key"}
                    >
                      {visible[provider.id] ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-2xl bg-emerald-400/[0.05] p-3 text-[11px] leading-5 text-white/50">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-300" />
        Provider keys are encrypted in Supabase Vault and are never returned to this screen.
      </div>
      {!consented ? (
        <div className="mt-3 rounded-2xl bg-amber-400/[0.08] p-3 text-[11px] leading-5 text-amber-100/80">
          Before TurtleBot sends relevant context to a selected AI provider, you must explicitly
          allow it in{" "}
          <Link to="/profile" className="font-semibold text-amber-200 underline">
            Profile → AI & privacy
          </Link>
          .
        </div>
      ) : null}
      <Button
        onClick={() => void save()}
        disabled={saving || !consented}
        className="mt-4 h-12 w-full rounded-2xl"
      >
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save Council
      </Button>
    </section>
  );
}
