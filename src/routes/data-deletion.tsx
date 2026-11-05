import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, LegalSection, LegalList } from "@/components/legal/LegalPage";
import { PRODUCT_NAME, SUPPORT_EMAIL, absoluteUrl } from "@/lib/legal/config";

const CANONICAL = absoluteUrl("/data-deletion");
const TITLE = "Data Deletion — Turtle Bot";
const DESC =
  "How to delete your Turtle Bot account and personal data, including if you signed in with a social provider and can no longer log in.";

export const Route = createFileRoute("/data-deletion")({
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
  component: DataDeletionPage,
});

const MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Data deletion request")}`;

function DataDeletionPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Data Deletion"
      intro={`You can have your ${PRODUCT_NAME} account and personal data deleted at any time. This page is the permanent, publicly reachable instruction page required by social login providers.`}
    >
      <LegalSection heading="Option 1 — delete from inside the app">
        <LegalList
          items={[
            "Sign in to Turtle Bot.",
            "Open Profile & Settings.",
            "Choose Delete account and confirm.",
          ]}
        />
        <p>
          Deletion begins immediately. Your session ends and any linked social identities are
          unlinked as part of the same operation.
        </p>
      </LegalSection>

      <LegalSection heading="Option 2 — email us (works if you cannot log in)">
        <p>
          Email{" "}
          <a className="text-cyan-300 hover:text-white" href={MAILTO}>
            {SUPPORT_EMAIL}
          </a>{" "}
          with the subject <span className="text-white/85">Data deletion request</span>. Include:
        </p>
        <LegalList
          items={[
            "The email address on the account, or the display name you used.",
            "Which login method you used (email and password, or the name of the social provider).",
          ]}
        />
        <p>
          We verify the request before acting on it, so that nobody can delete an account that is
          not theirs. We will not ask you for your password.
        </p>
      </LegalSection>

      <LegalSection heading="Option 3 — revoke at the provider">
        <p>
          Removing {PRODUCT_NAME} from a social provider's app settings revokes that provider's
          access and stops future sign-ins with it. It does not by itself delete your{" "}
          {PRODUCT_NAME} account — use option 1 or 2 for that.
        </p>
      </LegalSection>

      <LegalSection heading="What gets deleted">
        <LegalList
          items={[
            "Your profile, display name and avatar.",
            "All linked social identities and any provider tokens we hold.",
            "Your simulated (paper) trading history, strategy settings and preferences.",
            "Any stored exchange API credentials, which are destroyed rather than retained.",
            "Community membership and invitation records tied to you.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="What we may keep, and why">
        <p>
          We retain a limited set of security, audit and financial records for as long as the law
          requires or where we need them to resolve a dispute or prevent abuse. These records are
          minimised and are not used to build a profile of you. Aggregated statistics that cannot
          identify you may be retained.
        </p>
      </LegalSection>

      <LegalSection heading="Timing">
        <p>
          In-app deletion starts at once. Email requests are acknowledged and actioned within 30
          days of verification. Backups roll off on their own schedule and are overwritten within 90
          days.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
