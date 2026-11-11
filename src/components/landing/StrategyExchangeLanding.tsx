import { Link } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  Check,
  CircleDashed,
  ExternalLink,
  LockKeyhole,
  Network,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { QuorumarkLogo } from "@/components/brand/QuorumarkLogo";
import { WalletAccountMenu } from "@/components/wallet/WalletAccountMenu";

const agents = [
  { label: "Creator", x: 13, y: 26, tone: "cyan" },
  { label: "Research", x: 38, y: 12, tone: "ivory" },
  { label: "Signal", x: 64, y: 27, tone: "lime" },
  { label: "Your rules", x: 78, y: 62, tone: "amber" },
  { label: "Paper receipt", x: 39, y: 78, tone: "cyan" },
];

function IntelligenceScene() {
  const reduce = useReducedMotion();
  return (
    <div
      className="q-intelligence-scene"
      role="img"
      aria-label="The Quorumark Intelligence coordinating strategy research, signals, risk, and evidence"
    >
      <img
        className="q-intelligence-image"
        src="/assets/quorumark-intelligence-hero.png"
        alt="Synthetic intelligence coordinating strategy research and risk decisions"
      />
      <div className="q-scene-grid" />
      <div className="q-scene-core">
        <span />
        <b />
        <i />
      </div>
      <svg
        className="q-scene-lines"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M13 26 L38 12 L64 27 L78 62 L39 78 Z M13 26 L64 27 M38 12 L39 78 M64 27 L39 78" />
      </svg>
      {agents.map((agent, index) => (
        <motion.div
          key={agent.label}
          className={`q-agent-node q-agent-${agent.tone}`}
          style={{ left: `${agent.x}%`, top: `${agent.y}%` }}
          animate={reduce ? undefined : { y: [0, index % 2 ? -8 : 7, 0], opacity: [0.65, 1, 0.65] }}
          transition={{
            duration: 4 + index * 0.45,
            repeat: Infinity,
            delay: index * 0.25,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <span className="q-agent-dot" />
          <span>{agent.label}</span>
        </motion.div>
      ))}
      <motion.div
        className="q-signal-beam"
        animate={reduce ? undefined : { x: [0, 220, 0], opacity: [0, 1, 0] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: [0.22, 1, 0.36, 1] }}
      />
      <div className="q-scene-readout">
        <span>Decision graph</span>
        <strong>05 active agents</strong>
      </div>
    </div>
  );
}

function WordReveal({ children }: { children: string }) {
  const reduce = useReducedMotion();
  return (
    <>
      {children.split(" ").map((word, index) => (
        <motion.span
          key={`${word}-${index}`}
          className="q-reveal-word"
          initial={reduce ? { opacity: 1 } : { opacity: 0.3 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, amount: 0.75 }}
          transition={{
            delay: reduce ? 0 : index * 0.07,
            duration: 0.55,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          {word}{" "}
        </motion.span>
      ))}
    </>
  );
}

export function StrategyExchangeLanding() {
  const reduce = useReducedMotion();
  return (
    <main className="q-exchange-landing">
      <header className="q-landing-header">
        <Link to="/" aria-label="Quorumark home">
          <QuorumarkLogo compact />
        </Link>
        <nav>
          <a href="#how-it-works">How it works</a>
          <a href="#evidence">Verification</a>
          <Link to="/marketplace">Marketplace</Link>
        </nav>
        <WalletAccountMenu className="q-landing-wallet" />
      </header>
      <section className="q-landing-hero">
        <motion.div
          className="q-landing-copy"
          initial={reduce ? { opacity: 1 } : { opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="q-kicker">
            <span className="q-live-dot" /> The living intelligence network
          </p>
          <h1>
            Create strategies.
            <br />
            <span>Follow intelligence.</span>
            <br />
            Stay in control.
          </h1>
          <p>
            Quorumark is the strategy exchange for people who want to build, inspect, and follow
            autonomous methods without giving up control of their own risk.
          </p>
          <div className="q-landing-actions">
            <Link to="/marketplace" className="q-primary">
              Explore strategies <ArrowRight size={17} />
            </Link>
            <Link to="/studio" className="q-secondary">
              Create a strategy
            </Link>
          </div>
          <div className="q-landing-proof">
            <span>
              <Check size={14} /> Private strategy access
            </span>
            <span>
              <Check size={14} /> Independent follower rules
            </span>
          </div>
        </motion.div>
        <motion.div
          className="q-hero-visual"
          initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.1, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="q-hero-visual-top">
            <span>
              <Network size={16} /> Strategy intelligence
            </span>
            <b>Paper environment</b>
          </div>
          <IntelligenceScene />
          <div className="q-hero-visual-bottom">
            <span>Creator</span>
            <i />
            <span>Signal</span>
            <i />
            <span>Your policy</span>
            <i />
            <span>Evidence</span>
          </div>
        </motion.div>
      </section>
      <section className="q-landing-signal">
        <p className="q-kicker">The exchange principle</p>
        <h2>
          <WordReveal>Creators publish methods. Followers keep control.</WordReveal>
        </h2>
        <p>
          The strategy stays private. The decision path stays inspectable. Every follower can accept
          or reject the same signal under their own limits.
        </p>
      </section>
      <section className="q-landing-section" id="how-it-works">
        <div className="q-landing-section-heading">
          <p className="q-kicker">A complete strategy lifecycle</p>
          <h2>From first idea to an evidence backed paper decision.</h2>
        </div>
        <div className="q-lifecycle">
          <Step
            number="01"
            icon={<Sparkles size={19} />}
            title="Build and test"
            text="Describe a method, choose its markets, and test it with clearly labelled sample market data in Strategy Studio."
          />
          <Step
            number="02"
            icon={<LockKeyhole size={19} />}
            title="Publish and discover"
            text="Share a version without exposing private logic. Followers can inspect its risk and evidence class before subscribing."
          />
          <Step
            number="03"
            icon={<ShieldCheck size={19} />}
            title="Decide and verify"
            text="Each follower applies independent limits. Accepted paper executions stay linked to the original signal and version."
          />
        </div>
      </section>
      <section className="q-landing-section q-landing-split" id="evidence">
        <div>
          <p className="q-kicker">Evidence has a class</p>
          <h2>Performance should say what actually happened.</h2>
          <p>
            Backtested, paper traded, testnet executed, and live verified are separate categories.
            Quorumark keeps the label attached to the record.
          </p>
          <Link className="q-text-link" to="/verification">
            Inspect verification <ExternalLink size={14} />
          </Link>
        </div>
        <div className="q-evidence-card">
          <div className="q-evidence-head">
            <span>
              <CircleDashed size={17} /> Strategy record
            </span>
            <span className="q-status">
              <i /> Paper traded
            </span>
          </div>
          <div className="q-record-visual">
            <div className="q-record-line" />
            <span className="q-record-point q-record-point-one" />
            <span className="q-record-point q-record-point-two" />
            <span className="q-record-point q-record-point-three" />
          </div>
          <div className="q-evidence-stats">
            <div>
              <small>Source</small>
              <strong>Ledger</strong>
            </div>
            <div>
              <small>Class</small>
              <strong>Paper</strong>
            </div>
            <div>
              <small>Proof</small>
              <strong>Recomputed</strong>
            </div>
          </div>
          <p>
            <Check size={13} /> No hash is presented as settlement proof
          </p>
        </div>
      </section>
      <section className="q-landing-section q-near-section">
        <div className="q-near-mark">N</div>
        <div>
          <p className="q-kicker">Built around NEAR</p>
          <h2>Identity and intent rails, with execution still in your hands.</h2>
          <p>
            Native NEAR wallets are the primary identity path. Cross chain intent support stays
            isolated behind a guarded adapter until a supported testnet route is configured.
          </p>
          <Link className="q-text-link" to="/connect-wallet">
            See wallet options <ArrowRight size={14} />
          </Link>
        </div>
      </section>
      <section className="q-landing-section q-landing-cta">
        <p className="q-kicker">Your method has a place here</p>
        <h2>Make the decision path visible.</h2>
        <p>
          Build a strategy, test it in the paper environment, and decide what you want to follow.
        </p>
        <div className="q-landing-actions">
          <Link to="/studio" className="q-primary">
            Open Strategy Studio <ArrowRight size={17} />
          </Link>
          <Link to="/marketplace" className="q-secondary">
            Browse the exchange
          </Link>
        </div>
      </section>
      <section className="q-landing-faq">
        <details>
          <summary>Can a creator control my funds?</summary>
          <p>
            No. The follower policy runs independently, and the current product only produces paper
            executions.
          </p>
        </details>
        <details>
          <summary>What does paper traded mean?</summary>
          <p>
            The record was produced by Quorumark's sandbox execution engine. It is not a blockchain
            settlement or a live performance claim.
          </p>
        </details>
        <details>
          <summary>Why does NEAR matter here?</summary>
          <p>
            NEAR provides the identity and intent infrastructure for a strategy marketplace where
            access and evidence can be verified without handing over custody.
          </p>
        </details>
      </section>
      <footer className="q-landing-footer">
        <QuorumarkLogo />
        <span>Quorumark Strategy Exchange · paper and testnet environments only</span>
      </footer>
    </main>
  );
}

function Step({
  number,
  icon,
  title,
  text,
}: {
  number: string;
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <article className="q-lifecycle-step">
      <div className="q-step-top">
        <span>{icon}</span>
        <small>{number}</small>
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}
