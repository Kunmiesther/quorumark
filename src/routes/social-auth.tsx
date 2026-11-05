import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, LegalSection, LegalList } from "@/components/legal/LegalPage";
import { PRODUCT_NAME, SUPPORT_EMAIL, absoluteUrl } from "@/lib/legal/config";
import {
  PROVIDER_STATUS_LABEL,
  SOCIAL_PROVIDERS,
  type ProviderStatus,
} from "@/lib/social-auth/providers";
import {
  getSocialProviderReadiness,
  type ProviderReadiness,
} from "@/lib/social-auth/readiness.functions";

const CANONICAL = absoluteUrl("/social-auth");
const TITLE = "Social Login — Turtle Bot";
const DESC =
  "Which social login providers Turtle Bot supports, exactly what data each one shares, and how to disconnect or delete it.";

export const Route = createFileRoute("/social-auth")({
  loader: async () => ({ readiness: await getSocialProviderReadiness() }),
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:url", content: CANONICAL },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: CANONICAL }],
  }),
  component: SocialAuthPage,
});

const STATUS_TONE: Record<ProviderStatus, string> = {
  live: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  review_pending: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  sandbox: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  not_configured: "border-white/15 bg-white/[0.04] text-white/55",
};

function SocialAuthPage() {
  const { readiness } = Route.useLoaderData();

  return (
    <LegalPage
      eyebrow="Accounts"
      title="Social Login"
      intro={`How signing in to ${PRODUCT_NAME} with a third-party account works, what each provider shares with us, and what it never gives you access to.`}
    >
      <LegalSection heading="Providers and current status">
        <p>
          Status below is read live from our backend configuration. A provider only appears as an
          enabled button on the sign-in page when it is genuinely live — we never show a login
          option that would lead to a broken redirect.
        </p>
        <div className="mt-4 space-y-3">
          {SOCIAL_PROVIDERS.map((p) => {
            const state = (readiness as ProviderReadiness[]).find((r) => r.id === p.id);
            const status: ProviderStatus = state?.status ?? "not_configured";
            return (
              <div
                key={p.id}
                className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-display text-base font-semibold text-white">{p.label}</span>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] ${STATUS_TONE[status]}`}
                  >
                    {PROVIDER_STATUS_LABEL[status]}
                  </span>
                </div>
                <p className="mt-2 text-sm text-white/65">
                  {p.capability === "sharing_only"
                    ? "User-initiated sharing only. No standalone login is offered."
                    : state?.loginEnabled
                      ? `Sign-in available. Data shared: ${p.scopes.join(", ")}.`
                      : p.pendingLabel}
                </p>
              </div>
            );
          })}
        </div>
      </LegalSection>

      <LegalSection heading="What we receive">
        <LegalList
          items={[
            "The provider's user ID for you, so we can recognise you next time.",
            "Your display name and avatar URL, to personalise the interface.",
            "Your email address, only where the provider supplies one. Sign-in still works when it does not.",
          ]}
        />
        <p>
          We never receive your provider password. We do not read your posts, followers, friends,
          messages or feeds, and we never post on your behalf.
        </p>
      </LegalSection>

      <LegalSection heading="Account linking">
        <p>
          If the email a provider returns already belongs to a {PRODUCT_NAME} account, the social
          identity is linked to that existing account instead of creating a duplicate. You can use
          either method to sign in afterwards.
        </p>
      </LegalSection>

      <LegalSection heading="What social sign-in does not grant">
        <LegalList
          items={[
            "It does not grant access to the product. Access is invitation-only and an invitation must still be redeemed.",
            "It does not enable live trading. Live trading is separately restricted.",
            "It does not grant admin or community-moderation rights.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="Sharing your results">
        <p>
          Sharing is always something you start. You may download or share an image of your own
          completed simulated trade using your device's share sheet. Shared images are labelled as
          simulated results. {PRODUCT_NAME} never auto-posts to any network.
        </p>
      </LegalSection>

      <LegalSection heading="Disconnecting and deleting">
        <p>
          Disconnect a provider in account settings, and revoke {PRODUCT_NAME} in the provider's own
          app settings. To delete your account and data entirely, follow the Data Deletion page or
          email{" "}
          <a className="text-cyan-300 hover:text-white" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
