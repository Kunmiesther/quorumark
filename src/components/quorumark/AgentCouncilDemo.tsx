import { motion, useReducedMotion } from "framer-motion";
import { Check, CircleAlert, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useState } from "react";

type Scenario = "approved" | "rejected";
const scenarios = {
  approved: {
    action: "Allocate $240 to the reserve goal",
    policy: "Reserve policy · max $300 per action · quorum 2 of 3",
    outcome: "Approved by quorum",
    record: "QMR SIMULATED 0042",
    agents: [
      ["Thesis", "APPROVE", "The reserve is under target and the amount fits the plan."],
      ["Risk", "APPROVE", "Exposure remains below the account limit."],
      ["Structure", "HOLD", "Timing is acceptable, but no market signal is required."],
    ],
  },
  rejected: {
    action: "Allocate $680 to the reserve goal",
    policy: "Reserve policy · max $300 per action · quorum 2 of 3",
    outcome: "Rejected by policy",
    record: "QMR SIMULATED 0043",
    agents: [
      ["Thesis", "APPROVE", "The reserve is under target and needs funding."],
      ["Risk", "REJECT", "The proposed amount exceeds the policy cap."],
      ["Structure", "REJECT", "The action cannot proceed while the limit is breached."],
    ],
  },
} as const;

export function AgentCouncilDemo() {
  const [scenario, setScenario] = useState<Scenario>("approved");
  const [run, setRun] = useState(0);
  const reduce = useReducedMotion();
  const current = scenarios[scenario];
  return (
    <section id="demo" className="q-section q-demo-section">
      <div className="q-section-heading">
        <p className="q-eyebrow">Simulated council room</p>
        <h2>See the decision before it becomes an action.</h2>
        <p>
          Every proposal carries its policy, its dissent, and its receipt. This is a local
          demonstration, not live execution.
        </p>
      </div>
      <div className="q-demo-toolbar" role="group" aria-label="Choose demo scenario">
        <button
          className={scenario === "approved" ? "q-demo-tab active" : "q-demo-tab"}
          onClick={() => setScenario("approved")}
        >
          Approved path
        </button>
        <button
          className={scenario === "rejected" ? "q-demo-tab active" : "q-demo-tab"}
          onClick={() => setScenario("rejected")}
        >
          Rejected path
        </button>
        <button className="q-replay" onClick={() => setRun((value) => value + 1)}>
          <RotateCcw size={15} /> Replay
        </button>
      </div>
      <div className="q-council-card" key={`${scenario}-${run}`}>
        <motion.div
          className="q-demo-agent-art"
          aria-hidden="true"
          initial={reduce ? { opacity: 0.1 } : { opacity: 0, scale: 1.04 }}
          animate={{ opacity: 0.14, scale: 1 }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        >
          <img src="/assets/quorumark-agent-council.png" alt="" />
        </motion.div>
        <div className="q-council-summary">
          <div>
            <span className="q-label">Proposed action</span>
            <h3>{current.action}</h3>
          </div>
          <span className="q-simulated">SIMULATED</span>
        </div>
        <div className="q-policy-line">
          <ShieldCheck size={16} /> {current.policy}
        </div>
        <div className="q-agent-grid">
          {current.agents.map(([name, vote, reason], index) => {
            const approved = vote === "APPROVE";
            return (
              <motion.article
                key={name}
                className="q-agent-card"
                initial={reduce ? { opacity: 1 } : { opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.55,
                  delay: reduce ? 0 : index * 0.16,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <div className="q-agent-top">
                  <span className={`q-agent-index q-agent-${index}`}>0{index + 1}</span>
                  <span>{name}</span>
                </div>
                <div className={approved ? "q-vote q-vote-yes" : "q-vote q-vote-no"}>
                  {approved ? <Check size={15} /> : <X size={15} />}
                  {vote}
                </div>
                <p>{reason}</p>
              </motion.article>
            );
          })}
        </div>
        <div
          className={scenario === "approved" ? "q-outcome q-outcome-yes" : "q-outcome q-outcome-no"}
        >
          {scenario === "approved" ? <Check size={18} /> : <CircleAlert size={18} />}
          <div>
            <strong>{current.outcome}</strong>
            <span>{current.record} · policy checked before approval</span>
          </div>
        </div>
      </div>
    </section>
  );
}
