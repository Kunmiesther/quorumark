import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, LegalSection, LegalList } from "@/components/legal/LegalPage";
import { PRODUCT_NAME, absoluteUrl } from "@/lib/legal/config";

const CANONICAL = absoluteUrl("/risk-disclosure");
const TITLE = "Risk Disclosure — Turtle Bot";
const DESC =
  "Plain-language disclosure of the risks of automated and leveraged crypto trading, and the limits of simulated results.";

export const Route = createFileRoute("/risk-disclosure")({
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
  component: RiskDisclosurePage,
});

function RiskDisclosurePage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Risk Disclosure"
      intro={`${PRODUCT_NAME} is trading software, not a guarantee of profit. Read this before enabling any strategy.`}
    >
      <LegalSection heading="You can lose money">
        <p>
          Trading digital assets involves substantial risk of loss. Prices move sharply and without
          warning. You should only trade with money you can afford to lose entirely.
        </p>
      </LegalSection>

      <LegalSection heading="Leverage magnifies losses">
        <p>
          Leveraged positions can be liquidated by a small adverse price move, closing your position
          at a loss and consuming the margin committed to it. Higher leverage means a smaller move
          is needed to wipe out the position. Automation does not remove liquidation risk.
        </p>
      </LegalSection>

      <LegalSection heading="Simulated results are not real results">
        <LegalList
          items={[
            "Simulated (paper) trades are modelled, not executed on an exchange.",
            "They cannot fully reproduce slippage, partial fills, order rejections, funding costs, fee tiers or liquidity gaps.",
            "Past or simulated performance does not guarantee or indicate future results.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="Automation and technology risk">
        <LegalList
          items={[
            "Strategies act without asking you first. A strategy can open, add to or close positions while you are away.",
            "Exchanges, data feeds, networks and this platform can fail, lag, disconnect or return incorrect data, and orders may be delayed, rejected or duplicated.",
            "Configuration mistakes — wrong symbol, size, leverage or ladder — take effect exactly as configured.",
            "Software can contain defects despite testing and safeguards.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="AI output is not advice">
        <p>
          {PRODUCT_NAME} may show commentary, rankings or evaluations produced by AI models. These
          are informational, can be wrong or incomplete, and are not investment, financial, legal or
          tax advice or a recommendation to transact.
        </p>
      </LegalSection>

      <LegalSection heading="Custody and control">
        <p>
          {PRODUCT_NAME} is non-custodial: it never holds your funds and does not request or use
          withdrawal permissions. Your assets stay in your exchange account, and you remain
          responsible for that account, its security and its risk settings. You can revoke access at
          any time.
        </p>
      </LegalSection>

      <LegalSection heading="Regulatory and tax">
        <p>
          Availability and legality of leveraged crypto trading differ by jurisdiction. You are
          responsible for complying with the law that applies to you and for your own tax reporting.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
