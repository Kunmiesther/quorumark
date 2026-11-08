type PublicEnvName =
  | "VITE_SUPABASE_PROJECT_ID"
  | "VITE_SUPABASE_URL"
  | "VITE_SUPABASE_PUBLISHABLE_KEY"
  | "VITE_WALLETCONNECT_PROJECT_ID"
  | "VITE_PYTHON_BACKEND_URL"
  | "VITE_NEAR_EVIDENCE_CONTRACT_ID";

export type { PublicEnvName };

const REQUIRED_PUBLIC_BACKEND_ENV: PublicEnvName[] = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
];

const MISSING_ENV_SESSION_KEY = "quorumark_public_backend_env_missing_reported";
const PUBLIC_BACKEND_ENV_RETRY_DELAYS_MS = [0, 250, 750, 1_500];

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
      case "VITE_PYTHON_BACKEND_URL":
        return import.meta.env.VITE_PYTHON_BACKEND_URL || env.VITE_PYTHON_BACKEND_URL;
      case "VITE_NEAR_EVIDENCE_CONTRACT_ID":
        return import.meta.env.VITE_NEAR_EVIDENCE_CONTRACT_ID || env.VITE_NEAR_EVIDENCE_CONTRACT_ID;
    }
  })();
  return value && value.trim().length > 0 ? value : undefined;
}

export const PUBLIC_SUPABASE_PROJECT_ID = readPublicEnv("VITE_SUPABASE_PROJECT_ID");
export const PUBLIC_SUPABASE_URL = readPublicEnv("VITE_SUPABASE_URL");
export const PUBLIC_SUPABASE_PUBLISHABLE_KEY = readPublicEnv("VITE_SUPABASE_PUBLISHABLE_KEY");
export const PUBLIC_WALLETCONNECT_PROJECT_ID = readPublicEnv("VITE_WALLETCONNECT_PROJECT_ID");
export const PUBLIC_PYTHON_BACKEND_URL = readPublicEnv("VITE_PYTHON_BACKEND_URL");
export const PUBLIC_NEAR_EVIDENCE_CONTRACT_ID = readPublicEnv("VITE_NEAR_EVIDENCE_CONTRACT_ID");
export const PUBLIC_NEAR_NETWORK = (import.meta.env.VITE_NEAR_NETWORK || procEnv().VITE_NEAR_NETWORK || "testnet").trim();

export function getMissingPublicBackendEnv(): PublicEnvName[] {
  return REQUIRED_PUBLIC_BACKEND_ENV.filter((name) => !readPublicEnv(name));
}

export function hasPublicBackendEnv(): boolean {
  return getMissingPublicBackendEnv().length === 0;
}

export function getPublicBackendEnvMessage(missing = getMissingPublicBackendEnv()): string {
  return `Backend configuration needed. Set ${missing.join(", ")} in the Quorumark environment.`;
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
