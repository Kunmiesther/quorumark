/**
 * Owner/admin-only "Social App Review Kit" data.
 *
 * Gated by the 'admin' role in public.user_roles, exactly like the other admin
 * server functions. Returns credential PRESENCE booleans and the exact URLs a
 * provider review form asks for. Never returns secret values.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  SOCIAL_PROVIDERS,
  type ProviderStatus,
  type SocialProviderId,
} from "@/lib/social-auth/providers";
import { LEGAL_REVIEW_PENDING } from "@/lib/legal/config";

export interface SocialReviewKitProvider {
  id: SocialProviderId;
  status: ProviderStatus;
  hasClientId: boolean;
  hasClientSecret: boolean;
  loginEnabled: boolean;
}

export interface SocialReviewKit {
  providers: SocialReviewKitProvider[];
  /** Redirect URI registered with the backend auth layer, if resolvable. */
  backendCallbackUrl: string | null;
  appIconPresent: boolean;
  legalReviewPending: boolean;
}

async function assertAdmin(supabase: unknown, userId: string) {
  const client = supabase as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await client.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(`admin_check_failed: ${error.message}`);
  if (!data) throw new Error("Forbidden: admin role required");
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : undefined;
}

export const getSocialReviewKit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SocialReviewKit> => {
    await assertAdmin(context.supabase, context.userId);

    const providers = SOCIAL_PROVIDERS.map((p) => {
      const hasClientId = !!env(p.credentialEnv.clientId);
      const hasClientSecret = !!env(p.credentialEnv.clientSecret);
      const enabled = env(`SOCIAL_${p.id.toUpperCase()}_ENABLED`) === "true";
      const configured = hasClientId && hasClientSecret;
      const status: ProviderStatus = configured
        ? enabled
          ? "live"
          : "review_pending"
        : "not_configured";
      return {
        id: p.id,
        status,
        hasClientId,
        hasClientSecret,
        loginEnabled: status === "live" && p.supabaseProvider !== null,
      };
    });

    const base = env("SUPABASE_URL");
    return {
      providers,
      backendCallbackUrl: base ? `${base.replace(/\/$/, "")}/auth/v1/callback` : null,
      appIconPresent: true,
      legalReviewPending: LEGAL_REVIEW_PENDING,
    };
  });
