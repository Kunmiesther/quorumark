/**
 * Social-provider readiness. Server-authoritative, credential-presence only.
 *
 * Never returns secret values — only booleans and a derived status. The public
 * readiness call is what the login page uses to decide whether a provider
 * button is enabled, so we can never render a button that leads to a broken
 * redirect.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  SOCIAL_PROVIDERS,
  type ProviderStatus,
  type SocialProviderId,
} from "@/lib/social-auth/providers";

export interface ProviderReadiness {
  id: SocialProviderId;
  status: ProviderStatus;
  hasClientId: boolean;
  hasClientSecret: boolean;
  /** True only when a real, completable login flow exists right now. */
  loginEnabled: boolean;
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : undefined;
}

function computeReadiness(): ProviderReadiness[] {
  return SOCIAL_PROVIDERS.map((p) => {
    const hasClientId = !!readEnv(p.credentialEnv.clientId);
    const hasClientSecret = !!readEnv(p.credentialEnv.clientSecret);
    const enabled = readEnv(`SOCIAL_${p.id.toUpperCase()}_ENABLED`) === "true";
    const configured = hasClientId && hasClientSecret;

    let status: ProviderStatus = "not_configured";
    if (configured && enabled) status = "live";
    else if (configured) status = "review_pending";

    // Login is only ever possible for providers wired to the backend auth
    // layer. TikTok and Instagram have no login path yet, by design.
    const loginEnabled = status === "live" && p.supabaseProvider !== null;

    return { id: p.id, status, hasClientId, hasClientSecret, loginEnabled };
  });
}

/** Public: safe for the signed-out login page. Booleans only. */
export const getSocialProviderReadiness = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProviderReadiness[]> => computeReadiness(),
);
