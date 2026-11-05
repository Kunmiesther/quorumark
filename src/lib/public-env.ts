type PublicEnvName =
  | "VITE_SUPABASE_PROJECT_ID"
  | "VITE_SUPABASE_URL"
  | "VITE_SUPABASE_PUBLISHABLE_KEY"
  | "VITE_WALLETCONNECT_PROJECT_ID";

export type { PublicEnvName };

const REQUIRED_PUBLIC_BACKEND_ENV: PublicEnvName[] = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
];

const MISSING_ENV_SESSION_KEY = "tb_public_backend_env_missing_reported";
const PUBLIC_BACKEND_ENV_RETRY_DELAYS_MS = [0, 250, 750, 1_500];

// Hardcoded last-resort fallback. These are PUBLIC (publishable / anon) values
// and safe to ship in the client bundle. They exist so a broken build-time env
// injection can never take the whole app down with a "Backend configuration
// needed" screen. If the managed env vars are present they take precedence.
const HARDCODED_PUBLIC_ENV: Record<PublicEnvName, string | undefined> = {
  VITE_SUPABASE_PROJECT_ID: "sthdmulczzebfcmihhca",
  VITE_SUPABASE_URL: "https://sthdmulczzebfcmihhca.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_duAF8NclyRsIOgwEUgyWfw_UFvAxIvd",
  VITE_WALLETCONNECT_PROJECT_ID: undefined,
};

const proc: { env?: Record<string, string | undefined> } =
  typeof process !== "undefined" ? (process as unknown as { env?: Record<string, string | undefined> }) : {};

function procEnv() {
  return proc.env ?? {};
}

function readPublicEnv(name: PublicEnvName): string | undefined {
  const env = procEnv();
  const value = (() => {
    switch (name) {
      case "VITE_SUPABASE_PROJECT_ID":
        return (
          import.meta.env.VITE_SUPABASE_PROJECT_ID ||
          env.VITE_SUPABASE_PROJECT_ID ||
          env.SUPABASE_PROJECT_ID
        );
      case "VITE_SUPABASE_URL":
        return import.meta.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL || env.SUPABASE_URL;
      case "VITE_SUPABASE_PUBLISHABLE_KEY":
        return (
          import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
          env.VITE_SUPABASE_PUBLISHABLE_KEY ||
          env.SUPABASE_PUBLISHABLE_KEY
        );
      case "VITE_WALLETCONNECT_PROJECT_ID":
        return import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || env.VITE_WALLETCONNECT_PROJECT_ID;
    }
  })();
  const resolved = value && value.trim().length > 0 ? value : HARDCODED_PUBLIC_ENV[name];
  return resolved && resolved.trim().length > 0 ? resolved : undefined;
}


export const PUBLIC_SUPABASE_PROJECT_ID = HARDCODED_PUBLIC_ENV.VITE_SUPABASE_PROJECT_ID;
export const PUBLIC_SUPABASE_URL = HARDCODED_PUBLIC_ENV.VITE_SUPABASE_URL;
export const PUBLIC_SUPABASE_PUBLISHABLE_KEY = HARDCODED_PUBLIC_ENV.VITE_SUPABASE_PUBLISHABLE_KEY;
export const PUBLIC_WALLETCONNECT_PROJECT_ID = HARDCODED_PUBLIC_ENV.VITE_WALLETCONNECT_PROJECT_ID;

export function getMissingPublicBackendEnv(): PublicEnvName[] {
  return REQUIRED_PUBLIC_BACKEND_ENV.filter((name) => !readPublicEnv(name));
}

export function hasPublicBackendEnv(): boolean {
  return getMissingPublicBackendEnv().length === 0;
}

export function getPublicBackendEnvMessage(missing = getMissingPublicBackendEnv()): string {
  return `Backend configuration needed — restore ${missing.join(
    ", ",
  )} in Lovable project settings.`;
}

export function reportPublicBackendEnvMissingOnce(missing = getMissingPublicBackendEnv()) {
  if (typeof window === "undefined" || missing.length === 0) return;
  try {
    if (window.sessionStorage.getItem(MISSING_ENV_SESSION_KEY) === "1") return;
    window.sessionStorage.setItem(MISSING_ENV_SESSION_KEY, "1");
  } catch {
    // If sessionStorage is unavailable, still avoid breaking the app.
  }
  console.error(new Error(getPublicBackendEnvMessage(missing)));
}

export async function waitForPublicBackendEnv(): Promise<
  { ok: true; missing: [] } | { ok: false; missing: PublicEnvName[] }
> {
  const startedAt = Date.now();
  for (let index = 0; index < PUBLIC_BACKEND_ENV_RETRY_DELAYS_MS.length; index += 1) {
    const targetDelay = PUBLIC_BACKEND_ENV_RETRY_DELAYS_MS[index];
    const waitMs = Math.max(0, targetDelay - (Date.now() - startedAt));
    if (waitMs > 0 && typeof window !== "undefined") {
      await new Promise((resolve) => window.setTimeout(resolve, waitMs));
    }

    const missing = getMissingPublicBackendEnv();
    if (missing.length === 0) return { ok: true, missing: [] };
  }

  return { ok: false, missing: getMissingPublicBackendEnv() };
}

export function assertPublicBackendEnv() {
  const missing = getMissingPublicBackendEnv();
  if (missing.length > 0) {
    throw new Error(getPublicBackendEnvMessage(missing));
  }
}

export function requirePublicEnv(values: Partial<Record<PublicEnvName, string | undefined>>) {
  const missing = (Object.keys(values) as PublicEnvName[]).filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new Error(getPublicBackendEnvMessage(missing));
  }
}
