import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, LegalSection, LegalList } from "@/components/legal/LegalPage";
import { COMPANY_NAME, PRODUCT_NAME, SUPPORT_EMAIL, absoluteUrl } from "@/lib/legal/config";

const CANONICAL = absoluteUrl("/terms");
const TITLE = "Terms of Service — Quorumark";
const DESC =
  "The rules for using Quorumark Strategy Exchange, including paper execution, wallet access and acceptable use.";

export const Route = createFileRoute("/terms")({
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
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms of Service"
      intro={`These terms govern your use of ${PRODUCT_NAME}, operated by ${COMPANY_NAME}. By creating an account or using the platform you agree to them.`}
    >
      <LegalSection heading="1. Eligibility">
        <p>
          You must be at least 18 years old and legally able to enter into this agreement. You must
          not use {PRODUCT_NAME} where doing so would breach the law that applies to you.
        </p>
      </LegalSection>

      <LegalSection heading="2. Exchange access">
        <p>
          Marketplace browsing is public. Wallet authentication is required for creator and follower
          actions, and we may decline, limit or withdraw access at our discretion.
        </p>
      </LegalSection>

      <LegalSection heading="3. Simulated trading is the default">
        <p>
          Every account starts in simulated ("paper") mode. Simulated results are generated against
          market data and modelled execution. They are not real trades, they do not account for
          every real-world cost or execution constraint, and they are not a prediction of real
          results.
        </p>
      </LegalSection>

      <LegalSection heading="4. Execution environments">
        <p>
          Live trading is not enabled in this product assignment. Paper execution and supported testnet
          flows are separated from any future production environment:
        </p>
        <LegalList
          items={[
            "You remain solely responsible for the exchange account, its funds and its risk settings.",
            "You authorise only the paper or testnet action that you explicitly confirm.",
            "Quorumark is non-custodial. It does not hold, receive or withdraw follower funds.",
            "You can pause a follower policy or revoke wallet access at any time.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="5. No financial advice">
        <p>
          {PRODUCT_NAME} is software. Nothing on the platform — including strategy output, AI
          commentary, rankings or signals — is investment, financial, legal or tax advice, or a
          recommendation to buy or sell any asset. You make your own decisions.
        </p>
      </LegalSection>

      <LegalSection heading="6. Risk">
        <p>
          Trading digital assets, particularly with leverage, involves substantial risk including
          total loss. You could lose more than you expect and losses can happen quickly. See the
          Risk Disclosure for detail. Do not use funds you cannot afford to lose.
        </p>
      </LegalSection>

      <LegalSection heading="7. Your account">
        <LegalList
          items={[
            "Keep your credentials and any linked social account secure; you are responsible for activity under your account.",
            "Provide accurate information and keep it current.",
            "One person, one account, unless we agree otherwise in writing.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="8. Acceptable use">
        <LegalList
          items={[
            "Do not attempt to break, probe or circumvent platform security, rate limits or access controls.",
            "Do not scrape, resell, sublicense or redistribute the platform or its output.",
            "Do not use the platform for market manipulation, or for any unlawful or abusive purpose.",
            "Do not misrepresent simulated results as real trading performance when sharing them.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="9. Availability and changes">
        <p>
          We may change, suspend or discontinue features, and we may perform maintenance that
          interrupts service. Automated trading depends on third-party exchanges and data feeds that
          can fail, lag or return incorrect data. We do not guarantee uninterrupted or error-free
          operation.
        </p>
      </LegalSection>

      <LegalSection heading="10. Termination">
        <p>
          You may stop using {PRODUCT_NAME} and request deletion at any time. We may suspend or
          terminate access for breach of these terms, for security reasons, or where required by
          law.
        </p>
      </LegalSection>

      <LegalSection heading="11. Disclaimers and liability">
        <p>
          To the fullest extent permitted by law, the platform is provided "as is" without
          warranties of any kind, and {COMPANY_NAME} is not liable for trading losses, lost profits,
          or indirect or consequential damages arising from your use of the platform. Nothing in
          these terms limits liability that cannot lawfully be limited.
        </p>
      </LegalSection>

      <LegalSection heading="12. Contact">
        <p>
          Questions about these terms:{" "}
          <a className="text-cyan-300 hover:text-white" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
