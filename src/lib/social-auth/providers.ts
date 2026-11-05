/**
 * Config-driven social-login provider registry.
 *
 * This module holds ONLY static, public, client-safe metadata. Whether a
 * provider is actually usable is decided server-side by
 * `getSocialProviderReadiness` (src/lib/social-auth/readiness.functions.ts),
 * which reports credential presence as booleans and never leaks values.
 *
 * Truthfulness rule: a button is enabled only when the backend reports the
 * provider live. Otherwise it renders disabled with the real reason. We never
 * start an OAuth redirect that we know will break.
 */

import { LEGAL_ROUTES, SITE_URL, SUPPORT_EMAIL } from "@/lib/legal/config";

export type SocialProviderId = "facebook" | "x" | "tiktok" | "instagram";

export type ProviderStatus =
  | "not_configured"
  | "sandbox"
  | "review_pending"
  | "live";

export const PROVIDER_STATUS_LABEL: Record<ProviderStatus, string> = {
  not_configured: "Not configured",
  sandbox: "Sandbox / development",
  review_pending: "Review pending",
  live: "Live",
};

export interface SocialProviderMeta {
  id: SocialProviderId;
  label: string;
  /** Supabase auth provider slug, when the provider can be used for login. */
  supabaseProvider: "facebook" | "twitter" | null;
  /** What this provider is offered for today. */
  capability: "login" | "login_pending_approval" | "sharing_only";
  /** Shown on a disabled button. Must be literally true. */
  pendingLabel: string;
  scopes: string[];
  callbackPath: string;
  reviewPrerequisites: string[];
  /** Copy/paste description for the provider's app-review form. */
  reviewDescription: string;
  docsUrl: string;
  /** Env var names the backend looks for. Presence only, never values. */
  credentialEnv: { clientId: string; clientSecret: string };
}

export const SOCIAL_PROVIDERS: SocialProviderMeta[] = [
  {
    id: "facebook",
    label: "Facebook",
    supabaseProvider: "facebook",
    capability: "login",
    pendingLabel: "Setup pending Meta app configuration",
    scopes: ["public_profile", "email"],
    callbackPath: "/auth/callback",
    reviewPrerequisites: [
      "Meta app created in Live mode with a Business verification on file",
      "Privacy Policy URL, Terms URL and Data Deletion URL configured in App Settings → Basic",
      "Valid 1024×1024 app icon uploaded",
      "Facebook Login product added with the exact production redirect URI allow-listed",
      "Advanced access requested for public_profile and email only",
      "Screencast of the full login flow recorded for reviewers",
    ],
    reviewDescription:
      `${"Turtle Bot"} uses Facebook Login solely for authentication and account creation. We request public_profile and email only. The provider user ID, display name, avatar URL and email (when supplied) are used to create or link a single Turtle Bot account, show the user's name and avatar in the interface, and send transactional account email. We do not post to Facebook, do not read a user's friends, feed, pages or ads, and do not sell or share this data with third parties. Signing in with Facebook does not grant access to live trading; live trading remains restricted and requires separate owner-controlled entitlement. Users can disconnect Facebook or delete their account and data at any time from account settings or via the published Data Deletion instructions at ${SITE_URL}${LEGAL_ROUTES.dataDeletion}.`,
    docsUrl: "https://developers.facebook.com/docs/facebook-login/",
    credentialEnv: {
      clientId: "FACEBOOK_OAUTH_CLIENT_ID",
      clientSecret: "FACEBOOK_OAUTH_CLIENT_SECRET",
    },
  },
  {
    id: "x",
    label: "X",
    supabaseProvider: "twitter",
    capability: "login",
    pendingLabel: "Setup pending X developer app",
    scopes: ["users.read", "tweet.read", "offline.access"],
    callbackPath: "/auth/callback",
    reviewPrerequisites: [
      "X developer account with a project and an OAuth 2.0 app (Confidential client)",
      "OAuth 2.0 with PKCE enabled and the exact production callback URI allow-listed",
      "App type set to Web App, Automated App or Bot",
      "Website URL, Terms of Service URL and Privacy Policy URL set on the app",
      "Elevated/enterprise access only if email is required — X does not return email by default",
    ],
    reviewDescription:
      "Turtle Bot uses X OAuth 2.0 (authorization code with PKCE) for sign-in only. We read basic identity — the account's user ID, username, display name and avatar — and email address only where the platform makes it available. This information creates or links one Turtle Bot account and personalises the interface. We do not post, repost, like, follow, message or read timelines on the user's behalf, and we do not sell this data. Sign-in with X never grants live-trading eligibility. Users can disconnect X or delete their account and data at any time.",
    docsUrl: "https://docs.x.com/resources/fundamentals/authentication",
    credentialEnv: {
      clientId: "X_OAUTH_CLIENT_ID",
      clientSecret: "X_OAUTH_CLIENT_SECRET",
    },
  },
  {
    id: "tiktok",
    label: "TikTok",
    supabaseProvider: null,
    capability: "login_pending_approval",
    pendingLabel: "Setup pending developer approval",
    scopes: ["user.info.basic"],
    reviewPrerequisites: [
      "TikTok for Developers app created and submitted for review",
      "Login Kit product added with user.info.basic scope",
      "Exact production redirect URI registered (must be HTTPS, no wildcards)",
      "Verified web property (domain verification file or DNS TXT record)",
      "Privacy Policy URL and Terms of Service URL registered on the app",
      "Demo video of the login flow supplied to TikTok reviewers",
    ],
    callbackPath: "/auth/callback",
    reviewDescription:
      "Turtle Bot requests TikTok Login Kit with the user.info.basic scope only, for authentication and account creation. We use the open ID, display name and avatar to create or link a single Turtle Bot account and to personalise the interface; TikTok does not supply email and we do not require it. Sharing inside Turtle Bot is user-initiated: a user may export or share an image of their own completed simulated (paper) trade using the device share sheet or by downloading the image. We do not post to TikTok automatically and we do not request publishing scopes at this stage. TikTok sign-in never grants live-trading eligibility.",
    docsUrl: "https://developers.tiktok.com/doc/login-kit-web",
    credentialEnv: {
      clientId: "TIKTOK_CLIENT_KEY",
      clientSecret: "TIKTOK_CLIENT_SECRET",
    },
  },
  {
    id: "instagram",
    label: "Instagram",
    supabaseProvider: null,
    capability: "sharing_only",
    pendingLabel: "Sharing available; login pending Meta approval",
    scopes: [],
    callbackPath: "/auth/callback",
    reviewPrerequisites: [
      "Meta app with Instagram capabilities (Instagram API with Instagram Login or Facebook Login for Business)",
      "Business verification completed on the Meta app",
      "Privacy Policy, Terms and Data Deletion URLs configured",
      "No standalone Instagram login is claimed until an approved capability exists",
    ],
    reviewDescription:
      "Turtle Bot does not claim standalone Instagram login. Instagram involvement today is user-initiated sharing only: a user may download or share an image of their own completed simulated (paper) trade through the operating-system share sheet. Turtle Bot does not post to Instagram on a user's behalf, does not read Instagram content, and requests no Instagram permissions until an approved Meta capability exists.",
    docsUrl: "https://developers.facebook.com/docs/instagram-platform",
    credentialEnv: {
      clientId: "INSTAGRAM_OAUTH_CLIENT_ID",
      clientSecret: "INSTAGRAM_OAUTH_CLIENT_SECRET",
    },
  },
];

export function getProviderMeta(id: SocialProviderId): SocialProviderMeta {
  const found = SOCIAL_PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown_social_provider: ${id}`);
  return found;
}

/** URLs every provider review form asks for. */
export const REVIEW_URLS = {
  website: SITE_URL,
  privacy: `${SITE_URL}${LEGAL_ROUTES.privacy}`,
  terms: `${SITE_URL}${LEGAL_ROUTES.terms}`,
  dataDeletion: `${SITE_URL}${LEGAL_ROUTES.dataDeletion}`,
  support: `${SITE_URL}${LEGAL_ROUTES.support}`,
  socialAuthInfo: `${SITE_URL}${LEGAL_ROUTES.socialAuth}`,
  riskDisclosure: `${SITE_URL}${LEGAL_ROUTES.riskDisclosure}`,
  callback: `${SITE_URL}/auth/callback`,
  appIcon: `${SITE_URL}/brand/turtlebot-app-icon-1024.png`,
  ogImage: `${SITE_URL}/brand/turtlebot-og.png`,
  supportEmail: SUPPORT_EMAIL,
} as const;

/** Manual test matrix the owner must walk before submitting for review. */
export const REVIEW_TEST_CHECKLIST = [
  "New social user: first-time sign-in creates exactly one Turtle Bot profile",
  "Existing email collision: signing in with a provider that returns an already-registered email links to the same account, never a duplicate",
  "Invitation requirement: a freshly linked social account still has to redeem an invitation before entering the app",
  "Logout / revocation: signing out clears the session; revoking the app at the provider does not leave a usable session",
  "Account and data deletion: deletion request removes the account and unlinks all providers",
  "Denied / cancelled OAuth: cancelling at the provider returns a readable error, never a blank or broken page",
  "Provider missing email: sign-in still completes and the account is usable without an email address",
  "Mobile callback: the flow completes on iOS Safari and Android Chrome, including the return redirect",
  "Normal user live-access denial: a social-authenticated non-owner account cannot reach live trading",
] as const;
