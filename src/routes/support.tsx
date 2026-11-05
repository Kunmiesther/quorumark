import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, LegalSection, LegalList } from "@/components/legal/LegalPage";
import { PRODUCT_NAME, SUPPORT_EMAIL, absoluteUrl } from "@/lib/legal/config";

const CANONICAL = absoluteUrl("/support");
const TITLE = "Support — Turtle Bot";
const DESC =
  "Contact Turtle Bot support: how to reach us, what to include, response expectations and how to report a security issue.";

export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:url", content: CANONICAL },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: CANONICAL }],
  }),
  component: SupportPage,
});

function SupportPage() {
  return (
    <LegalPage
      eyebrow="Help"
      title="Support"
      intro={`Reach a human about your ${PRODUCT_NAME} account, a login problem, or a security concern.`}
    >
      <LegalSection heading="Contact">
        <p>
          Email{" "}
          <a className="text-cyan-300 hover:text-white" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          . This inbox is monitored on business days and is the address we publish to identity
          providers for review correspondence.
        </p>
      </LegalSection>

      <LegalSection heading="What to include">
        <LegalList
          items={[
            "The email address or display name on your account.",
            "How you sign in — email and password, or which social provider.",
            "What you expected to happen and what actually happened.",
            "The time it happened and the device/browser you used.",
            "A screenshot, where it helps. Never send passwords or exchange API secrets.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="Response expectations">
        <LegalList
          items={[
            "General questions: within 2 business days.",
            "Login and access problems: prioritised, usually within 1 business day.",
            "Data deletion requests: acknowledged on receipt and actioned within 30 days of verification.",
            "Suspected security issues: treated as urgent.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="Common issues">
        <LegalList
          items={[
            <>
              <strong className="text-white/85">Social sign-in fails or returns an error.</strong>{" "}
              Confirm the provider is listed as available on the Social Login page. If it is, try a
              normal browser window rather than an in-app webview, then contact us with the exact
              error text.
            </>,
            <>
              <strong className="text-white/85">Signed in but cannot enter the app.</strong> Access
              is invitation-only. Creating an account does not grant access until an invitation is
              redeemed.
            </>,
            <>
              <strong className="text-white/85">Wrong account after social sign-in.</strong> A
              provider that returns an already-registered email links to that existing account by
              design. Contact us if you believe two accounts should be separate.
            </>,
            <>
              <strong className="text-white/85">Want your data removed.</strong> Follow the Data
              Deletion page.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection heading="Reporting a security issue">
        <p>
          Email{" "}
          <a
            className="text-cyan-300 hover:text-white"
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Security report")}`}
          >
            {SUPPORT_EMAIL}
          </a>{" "}
          with the subject <span className="text-white/85">Security report</span>. Please give us a
          reasonable window to investigate and fix before disclosing publicly, and do not access,
          modify or delete data that is not yours while testing.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
