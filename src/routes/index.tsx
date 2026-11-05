import { createFileRoute, Link } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Check, FileCheck2, LockKeyhole, Scale, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { AgentCouncilDemo } from "@/components/quorumark/AgentCouncilDemo";
import { CinematicDecisionInstrument } from "@/components/quorumark/CinematicDecisionInstrument";
import { QuorumarkLogo } from "@/components/brand/QuorumarkLogo";

const TITLE = "Quorumark · The control room for autonomous finance";
const DESCRIPTION =
  "Specialized AI agents evaluate financial actions, enforce explicit policies, and leave an auditable decision record.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LandingPage,
});

function LandingPage() {
  const reduce = useReducedMotion();
  return (
    <main className="q-site">
      <header className="q-landing-nav">
        <Link to="/" aria-label="Quorumark home">
          <QuorumarkLogo compact />
        </Link>
        <nav aria-label="Landing navigation" className="q-landing-links">
          <a href="#council">Agent council</a>
          <a href="#policies">Policies</a>
          <a href="#demo">Demo</a>
        </nav>
        <Link to="/auth" className="q-nav-cta">
          Sign in <ArrowRight size={15} />
        </Link>
      </header>
      <section className="q-hero">
        <div className="q-hero-rule" aria-hidden="true" />
        <motion.div
          className="q-hero-copy"
          initial={reduce ? { opacity: 1 } : { opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="q-eyebrow">
            <span className="q-live-dot" /> A financial decision system
          </p>
          <h1>
            Your money. Your rules.
            <br />
            <span>Agents that answer to both.</span>
          </h1>
          <p className="q-hero-lede">
            Quorumark brings specialized AI agents together to evaluate financial decisions, enforce
            your limits, and show exactly why an action was approved or rejected.
          </p>
          <div className="q-actions">
            <Link to="/welcome" className="q-button q-button-primary">
              Explore the demo <ArrowRight size={17} />
            </Link>
            <a href="#demo" className="q-button q-button-secondary">
              Watch a decision
            </a>
          </div>
          <p className="q-proof">
            <LockKeyhole size={14} /> Local demonstration · no live trading · NEAR integration
            planned
          </p>
        </motion.div>
        <CinematicDecisionInstrument reduce={!!reduce} />
      </section>
      <section className="q-tagline" aria-label="Quorumark principle">
        <p>
          {["Good", "automation", "does", "not", "ask", "for", "trust."].map((word, index) => (
            <motion.span
              key={word}
              className="q-word"
              initial={reduce ? { opacity: 1 } : { opacity: 0.32 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true, amount: 0.8 }}
              transition={{
                delay: reduce ? 0 : index * 0.07,
                duration: 0.55,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {word}{" "}
            </motion.span>
          ))}
        </p>
        <p>
          {["It", "shows", "its", "work."].map((word, index) => (
            <motion.span
              key={word}
              className="q-word"
              initial={reduce ? { opacity: 1 } : { opacity: 0.32 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true, amount: 0.8 }}
              transition={{
                delay: reduce ? 0 : 0.5 + index * 0.07,
                duration: 0.55,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {word}{" "}
            </motion.span>
          ))}
        </p>
      </section>
      <section id="council" className="q-section">
        <div className="q-section-heading">
          <p className="q-eyebrow">One proposal, three perspectives</p>
          <h2>A council that can disagree before you commit.</h2>
          <p>
            Quorumark separates conviction from caution. Each agent sees the same evidence,
            contributes a typed decision, and leaves a reason you can inspect.
          </p>
        </div>
        <div className="q-feature-grid">
          <Feature
            icon={<Scale size={20} />}
            number="01"
            title="Thesis"
            text="Frames the opportunity and explains what would make the action worthwhile."
            tone="cyan"
          />
          <Feature
            icon={<ShieldCheck size={20} />}
            number="02"
            title="Risk"
            text="Challenges the proposal against exposure, limits, and failure conditions."
            tone="lime"
          />
          <Feature
            icon={<FileCheck2 size={20} />}
            number="03"
            title="Structure"
            text="Checks the action shape, timing, and evidence before a vote counts."
            tone="amber"
          />
        </div>
      </section>
      <section id="policies" className="q-policy-section">
        <div>
          <p className="q-eyebrow">Policies are the authority</p>
          <h2>Make your limits explicit. Let the system enforce them.</h2>
          <p>
            Set caps, approval thresholds, allowed actions, and expiry windows in plain language.
            The agents can recommend. The policy decides.
          </p>
        </div>
        <div className="q-policy-card">
          <div className="q-policy-card-head">
            <span>Reserve policy</span>
            <span className="q-policy-status">
              <Check size={13} /> Active
            </span>
          </div>
          <div className="q-policy-row">
            <span>Per action</span>
            <strong>$300 max</strong>
          </div>
          <div className="q-policy-row">
            <span>Daily total</span>
            <strong>$900 max</strong>
          </div>
          <div className="q-policy-row">
            <span>Approval</span>
            <strong>2 of 3 agents</strong>
          </div>
          <div className="q-policy-row">
            <span>Human review</span>
            <strong>Required</strong>
          </div>
        </div>
      </section>
      <AgentCouncilDemo />
      <section className="q-clarity">
        <p className="q-eyebrow">What is real today</p>
        <h2>A focused foundation for accountable finance.</h2>
        <div className="q-clarity-grid">
          <div>
            <span className="q-status-dot q-status-live" />
            Working foundation
            <p>
              Structured agent decisions, policy concepts, safety controls, audit surfaces, and this
              local deterministic demonstration.
            </p>
          </div>
          <div>
            <span className="q-status-dot q-status-next" />
            Next phase
            <p>
              NEAR based receipts, testnet execution, and a verifiable onchain policy layer. Not
              connected yet.
            </p>
          </div>
          <div>
            <span className="q-status-dot q-status-not" />
            Not claimed
            <p>
              No live autonomous trading, financial returns, or completed NEAR execution is
              represented here.
            </p>
          </div>
        </div>
      </section>
      <footer className="q-footer">
        <QuorumarkLogo />
        <div>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/risk-disclosure">Risk disclosure</Link>
          <Link to="/auth">Sign in</Link>
        </div>
        <p>Quorumark is a product in development. Demonstrations use fictional data.</p>
      </footer>
    </main>
  );
}

function Feature({
  icon,
  number,
  title,
  text,
  tone,
}: {
  icon: ReactNode;
  number: string;
  title: string;
  text: string;
  tone: string;
}) {
  return (
    <motion.article
      className={`q-feature q-feature-${tone}`}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.35 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="q-feature-top">
        <span className="q-feature-icon">{icon}</span>
        <span>{number}</span>
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </motion.article>
  );
}
