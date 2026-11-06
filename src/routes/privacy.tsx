import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, LegalSection, LegalList } from "@/components/legal/LegalPage";
import { COMPANY_NAME, PRODUCT_NAME, SUPPORT_EMAIL, absoluteUrl } from "@/lib/legal/config";

const CANONICAL = absoluteUrl("/privacy");
const TITLE = "Privacy Policy — Quorumark";
const DESC =
  "How Quorumark collects, uses, retains and deletes personal data for wallet based strategy exchange access.";

export const Route = createFileRoute("/privacy")({
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
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Privacy Policy"
      intro={`This policy explains what ${PRODUCT_NAME}, operated by ${COMPANY_NAME}, collects about you, why we collect it, how long we keep it, and how you can have it deleted.`}
    >
      <LegalSection heading="1. Who we are">
        <p>
          {PRODUCT_NAME} is an automated trading interface operated by {COMPANY_NAME}. Contact us
          about anything in this policy at{" "}
          <a className="text-cyan-300 hover:text-white" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection heading="2. Data we collect">
        <LegalList
          items={[
            <>
              <strong className="text-white/85">Account data.</strong> Email address, password hash
              (never the password itself), display name and account creation time.
            </>,
            <>
              <strong className="text-white/85">Wallet identity data.</strong> When you connect a
              wallet we receive the public address, chain, provider name and the signed challenge
              result needed to establish a session.
            </>,
            <>
              <strong className="text-white/85">Product data.</strong> Simulated (paper) trading
              activity, strategy settings, invitation and community membership, notifications and
              in-app preferences.
            </>,
            <>
              <strong className="text-white/85">Exchange connection data.</strong> If you connect an
              exchange account, we store encrypted API credentials scoped to trading only. See
              section 6.
            </>,
            <>
              <strong className="text-white/85">Technical data.</strong> IP address, device and
              browser information, and server logs used for security, abuse prevention and
              debugging.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection heading="3. Why we use it">
        <LegalList
          items={[
            "To create and authenticate your account, including linking a social identity to an existing account.",
            "To operate the product: run simulated trading, show your results, and deliver notifications you asked for.",
            "To keep the platform safe: rate limiting, fraud and abuse prevention, and audit trails for trading actions.",
            "To respond to your support requests.",
            "To meet legal, tax and record-keeping obligations.",
          ]}
        />
        <p>
          We do not sell your personal data, and we do not use social-login data for advertising or
          profiling.
        </p>
      </LegalSection>

      <LegalSection heading="4. Wallet authentication and account linking">
        <p>
          Connecting a wallet means that the wallet signs an expiring, domain bound challenge. We
          receive the public identity fields listed in section 2 and never receive a private key or
          seed phrase.
        </p>
        <LegalList
          items={[
            "If a verified wallet already belongs to a Quorumark account, the wallet identity is linked to that existing account. We do not create a second account.",
            "Provider access tokens are held server-side only. They are never written to any table that client applications can read.",
            "Wallet connection never grants live trading eligibility or paid entitlements. Those are granted separately and are not affected by how you connect.",
            "You can disconnect a wallet at any time in account settings and revoke Quorumark access from the wallet provider.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="5. Third parties involved">
        <p>
          We use service providers to run the platform: cloud hosting and managed database/auth
          infrastructure, email delivery, and the identity providers you choose to sign in with.
          Where you connect an exchange, that exchange receives the trading instructions we send on
          your behalf. Each of these parties receives only what it needs to perform its function.
        </p>
      </LegalSection>

      <LegalSection heading="6. Exchange credentials and security">
        <p>
          Exchange API credentials are encrypted at rest and used only to place, amend and cancel
          orders in the account you connected. {PRODUCT_NAME} operates non-custodially: it never
          holds your funds and withdrawal permissions are not requested or used. Access to
          production systems is restricted, and trading actions are logged for audit.
        </p>
      </LegalSection>

      <LegalSection heading="7. Retention">
        <LegalList
          items={[
            "Account and profile data: kept while your account exists.",
            "Simulated trading records: kept while your account exists, then deleted or irreversibly anonymised on account deletion.",
            "Security, audit and transaction logs: retained for a limited period after deletion where we are required to keep them for legal, tax, security or dispute-resolution reasons.",
            "Support correspondence: retained for as long as needed to handle the request and any follow-up.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="8. Your rights and deletion">
        <p>
          You can request access to, correction of, or deletion of your personal data. Full
          instructions — including how to delete your data when you can no longer log in — are on
          the Data Deletion page.
        </p>
      </LegalSection>

      <LegalSection heading="9. Children">
        <p>
          {PRODUCT_NAME} is not offered to anyone under 18. We do not knowingly collect data from
          children.
        </p>
      </LegalSection>

      <LegalSection heading="10. Changes to this policy">
        <p>
          We update this page when our practices change and revise the "last updated" date above.
          Material changes will be communicated in-app or by email.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
