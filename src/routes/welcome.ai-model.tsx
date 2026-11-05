import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, Users } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { ProgressDots } from "@/components/welcome/ProgressDots";
import onyx from "@/assets/onyx-head.png.asset.json";

export const Route = createFileRoute("/welcome/ai-model")({
  component: AiModelStep,
  head: () => ({ meta: [{ title: "Choose your AI model — Turtle Bot" }] }),
});

type Provider = "openai" | "anthropic" | "google";
type ModelOption = {
  id: string;
  name: string;
  note: string;
  image: string;
  provider?: Provider;
  model?: string;
};
type ExternalModelOption = ModelOption & { provider: Provider; model: string };

const MODELS: readonly ModelOption[] = [
  { id: "onyx", name: "Onyx", note: "TurtleBot's native trading intelligence", image: onyx.url },
  { id: "chatgpt", name: "ChatGPT", note: "OpenAI reasoning and market analysis", image: "/brand/openai.svg", provider: "openai" as Provider, model: "gpt-5.4" },
  { id: "claude", name: "Claude", note: "Anthropic analysis and risk review", image: "/brand/anthropic.svg", provider: "anthropic" as Provider, model: "claude-sonnet-4-6" },
  { id: "gemini", name: "Gemini", note: "Google multimodal market intelligence", image: "/brand/google-gemini.svg", provider: "google" as Provider, model: "gemini-2.5-pro" },
];

function isExternalModel(model: ModelOption): model is ExternalModelOption {
  return model.provider !== undefined && model.model !== undefined;
}

function AiModelStep() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [council, setCouncil] = useState(false);
  const [selected, setSelected] = useState<string[]>(["onyx"]);
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [visible, setVisible] = useState<Partial<Record<Provider, boolean>>>({});
  const [saved, setSaved] = useState<Partial<Record<Provider, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/welcome" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void supabase.functions.invoke("llm-credentials", { body: { action: "summary" } }).then(({ data }) => {
      if (!active || !data?.ok) return;
      const next: Partial<Record<Provider, string>> = {};
      for (const row of data.providers ?? []) next[row.provider as Provider] = row.key_last_four;
      setSaved(next);
    });
    return () => { active = false; };
  }, [user]);

  if (loading || !user) return null;

  function choose(id: string) {
    if (!council) return setSelected([id]);
    setSelected((items) => items.includes(id)
      ? items.filter((item) => item !== id)
      : items.length < 3 ? [...items, id] : items);
  }

  async function continueFlow() {
    const providers = MODELS
      .filter((model): model is ExternalModelOption => selected.includes(model.id) && isExternalModel(model))
      .map((model) => model.provider);
    if (council && providers.some((provider) => !saved[provider] && !keys[provider]?.trim())) {
      setError("Add an API key for each external AI Council model.");
      return;
    }
    setSaving(true);
    setError(null);
    const pending = providers.filter((provider) => keys[provider]?.trim());
    const results = await Promise.all(pending.map((provider) =>
      supabase.functions.invoke("llm-credentials", {
        body: { action: "save", provider, api_key: keys[provider]?.trim() },
      })
    ));
    const failed = results.find(({ data, error: saveError }) => saveError || !data?.ok);
    if (failed) {
      setSaving(false);
      setError(failed.data?.message ?? "An API key could not be saved securely.");
      return;
    }
    const councilResult = await supabase.functions.invoke("llm-credentials", {
      body: {
        action: "save_council",
        enabled: council,
        seats: selectedExternal.map((model) => ({ provider: model.provider, model: model.model })),
      },
    });
    if (councilResult.error || !councilResult.data?.ok) {
      setSaving(false);
      setError(councilResult.data?.message ?? "The AI Council selection could not be saved.");
      return;
    }
    setSaving(false);
    sessionStorage.setItem("tb_ai_models", JSON.stringify({ council, models: selected }));
    navigate({ to: "/welcome/bills" });
  }

  const selectedExternal = MODELS.filter(
    (model): model is ExternalModelOption => selected.includes(model.id) && isExternalModel(model),
  );

  return (
    <div className="flex flex-1 flex-col pb-3">
      <ProgressDots step={6} total={9} />
      <p className="mt-8 text-center text-[10px] uppercase tracking-[.3em] text-purple-300/80">AI setup</p>
      <h1 className="mt-4 text-center font-display text-2xl font-bold">Choose your AI model</h1>
      <p className="mt-2 text-center text-sm text-muted-foreground">Choose one model, or turn on AI Council to select up to three.</p>

      <button type="button" aria-pressed={council} className="welcome-neo-button welcome-model-card mt-6 flex items-center gap-3 rounded-2xl p-4 text-left" onClick={() => { setCouncil((value) => !value); setSelected(["onyx"]); setError(null); }}>
        <Users className="h-6 w-6 text-purple-400" />
        <span className="flex-1"><strong className="block text-sm">AI Council</strong><span className="text-xs text-muted-foreground">Choose up to 3 models and add their API keys</span></span>
        <span className={"welcome-council-switch relative h-7 w-12 rounded-full border " + (council ? "is-active" : "")}><span className="absolute top-1 h-5 w-5 rounded-full bg-white" /></span>
      </button>

      <p className={"mt-3 text-xs " + (council ? "text-muted-foreground" : "text-center text-purple-300")}>
        {council ? selected.length + " of 3 selected" : "Onyx is recommended for the best native TurtleBot experience."}
      </p>

      <div className="mt-4 space-y-3">
        {MODELS.map((model, index) => {
          const active = selected.includes(model.id);
          return (
            <button key={model.id} type="button" onClick={() => choose(model.id)} style={{ animationDelay: index * 70 + "ms" }} className={"welcome-neo-button welcome-model-card flex w-full items-center gap-3 rounded-2xl p-4 text-left " + (active ? "is-selected" : "")}>
              <span className={"welcome-model-logo flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full " + (model.id === "onyx" ? "welcome-onyx-logo" : "")}>
                <img src={model.image} alt={model.name + " logo"} className="h-full w-full object-contain" />
              </span>
              <span className="flex-1"><strong className="block text-sm">{model.name}</strong><span className="text-xs text-muted-foreground">{model.note}</span></span>
              <span className={"welcome-model-check flex h-7 w-7 items-center justify-center rounded-full border " + (active ? "is-active" : "")}>{active ? <Check className="h-4 w-4" /> : null}</span>
            </button>
          );
        })}
      </div>

      {council && selectedExternal.length ? (
        <section className="welcome-provider-panel mt-5 rounded-[22px] p-4">
          <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-purple-300" /><div><h2 className="text-sm font-semibold">Connect selected models</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Keys are encrypted in Supabase Vault and are never displayed again.</p></div></div>
          <div className="mt-4 space-y-3">
            {selectedExternal.map((model) => {
              const provider = model.provider;
              return (
                <label key={provider} className="welcome-provider-key block rounded-2xl p-3">
                  <span className="mb-2 flex items-center gap-2"><img src={model.image} alt="" className="h-5 w-5" /><strong className="text-xs">{model.name}</strong>{saved[provider] ? <span className="ml-auto text-[10px] text-emerald-300">Connected •••• {saved[provider]}</span> : null}</span>
                  <span className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 shrink-0 text-purple-300" />
                    <input type={visible[provider] ? "text" : "password"} value={keys[provider] ?? ""} onChange={(event) => setKeys((current) => ({ ...current, [provider]: event.target.value }))} placeholder={saved[provider] ? "Enter a new key to replace it" : "Add " + model.name + " API key"} autoComplete="new-password" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/50" />
                    <button type="button" onClick={() => setVisible((current) => ({ ...current, [provider]: !current[provider] }))} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground" aria-label={visible[provider] ? "Hide API key" : "Show API key"}>{visible[provider] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
      ) : null}

      {error ? <p role="alert" className="mt-4 rounded-2xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-xs text-red-200">{error}</p> : null}
      <button onClick={() => void continueFlow()} disabled={!selected.length || saving} className="welcome-primary-action mt-6 flex h-14 items-center justify-center font-semibold text-white disabled:opacity-40">{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Continue</button>
    </div>
  );
}
