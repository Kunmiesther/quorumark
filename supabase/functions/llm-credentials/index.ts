import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
const allowed = new Set(["openai", "anthropic", "google"]);
const allowedModels: Record<string, Set<string>> = {
  openai: new Set(["gpt-5.4", "gpt-5.4-mini"]),
  anthropic: new Set(["claude-sonnet-4-6", "claude-haiku-4-5"]),
  google: new Set(["gemini-2.5-pro", "gemini-2.5-flash"]),
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const out = (s: number, b: Record<string, unknown>) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "content-type": "application/json" },
  });
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return out(405, { ok: false, message: "POST required." });
  const url = Deno.env.get("SUPABASE_URL"),
    role = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !role) return out(500, { ok: false, message: "Credential service is unavailable." });
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const admin = createClient(url, role, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: a, error: ae } = await admin.auth.getUser(token);
  if (ae || !a.user) return out(401, { ok: false, message: "Sign in required." });
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return out(400, { ok: false, message: "Invalid request." });
  }
  const action = String(b.action ?? "summary");
  if (action === "summary") {
    const [
      { data: providers, error: providerError },
      { data: council, error: councilError },
      { data: profile, error: profileError },
    ] = await Promise.all([
      admin
        .from("user_llm_credentials")
        .select("provider,key_last_four,updated_at")
        .eq("user_id", a.user.id),
      admin
        .from("user_ai_council")
        .select("enabled,seats,updated_at")
        .eq("user_id", a.user.id)
        .maybeSingle(),
      admin
        .from("profiles")
        .select("ai_data_consent_at,ai_data_consent_version")
        .eq("id", a.user.id)
        .maybeSingle(),
    ]);
    return providerError || councilError || profileError
      ? out(500, { ok: false, message: "Could not load AI Council settings." })
      : out(200, {
          ok: true,
          providers: providers ?? [],
          council: council ?? { enabled: false, seats: [] },
          ai_consent: {
            granted: Boolean(profile?.ai_data_consent_at),
            version: profile?.ai_data_consent_version ?? null,
          },
        });
  }
  const { data: consent, error: consentError } = await admin
    .from("profiles")
    .select("ai_data_consent_at")
    .eq("id", a.user.id)
    .maybeSingle();
  if (consentError)
    return out(500, { ok: false, message: "Could not verify AI privacy permission." });
  if (!consent?.ai_data_consent_at)
    return out(403, {
      ok: false,
      message: "Enable AI data sharing in Profile before connecting a Council provider.",
    });
  if (action === "save_council") {
    const enabled = b.enabled === true;
    if (!Array.isArray(b.seats) || b.seats.length > 3)
      return out(400, { ok: false, message: "Choose up to three Council seats." });
    if (enabled && b.seats.length !== 3)
      return out(400, {
        ok: false,
        message: "An enabled Council requires three independent seats.",
      });
    const seats = [] as Array<{ provider: string; model: string }>;
    const seen = new Set<string>();
    for (const raw of b.seats) {
      if (!raw || typeof raw !== "object")
        return out(400, { ok: false, message: "Invalid Council seat." });
      const provider = String((raw as Record<string, unknown>).provider ?? "");
      const model = String((raw as Record<string, unknown>).model ?? "");
      if (!allowed.has(provider) || !allowedModels[provider]?.has(model) || seen.has(provider))
        return out(400, { ok: false, message: "Unsupported or duplicate Council seat." });
      seen.add(provider);
      seats.push({ provider, model });
    }
    const { data: keys, error: keyError } = await admin
      .from("user_llm_credentials")
      .select("provider")
      .eq("user_id", a.user.id)
      .in(
        "provider",
        seats.map((s) => s.provider),
      );
    if (keyError)
      return out(500, { ok: false, message: "Could not validate provider connections." });
    const connected = new Set((keys ?? []).map((row) => String(row.provider)));
    if (enabled && seats.some((seat) => !connected.has(seat.provider)))
      return out(400, { ok: false, message: "Connect an API key for every enabled Council seat." });
    const { error } = await admin
      .from("user_ai_council")
      .upsert({ user_id: a.user.id, enabled, seats }, { onConflict: "user_id" });
    return error
      ? out(500, { ok: false, message: "Could not save AI Council settings." })
      : out(200, { ok: true, council: { enabled, seats } });
  }
  const provider = String(b.provider ?? "");
  if (!allowed.has(provider)) return out(400, { ok: false, message: "Unsupported provider." });
  if (action === "save") {
    const key = String(b.api_key ?? "").trim();
    if (key.length < 8 || key.length > 512)
      return out(400, { ok: false, message: "Enter a valid API key." });
    const { error } = await admin.rpc("store_user_llm_credential", {
      p_user_id: a.user.id,
      p_provider: provider,
      p_secret: key,
    });
    return error
      ? out(500, { ok: false, message: "Could not securely save this key." })
      : out(200, { ok: true, provider, key_last_four: key.slice(-4) });
  }
  if (action === "delete") {
    const { error } = await admin.rpc("delete_user_llm_credential", {
      p_user_id: a.user.id,
      p_provider: provider,
    });
    return error
      ? out(500, { ok: false, message: "Could not remove this key." })
      : out(200, { ok: true, provider });
  }
  return out(400, { ok: false, message: "Unknown action." });
});
