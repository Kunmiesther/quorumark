import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { useRef } from "react";

const agents = [
  { name: "THESIS", vote: "YES", tone: "cyan" },
  { name: "RISK", vote: "YES", tone: "lime" },
  { name: "STRUCTURE", vote: "HOLD", tone: "amber" },
];

export function CinematicDecisionInstrument({ reduce }: { reduce: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const rotateY = useSpring(useTransform(pointerX, [-1, 1], [-4, 4]), {
    stiffness: 110,
    damping: 24,
  });
  const rotateX = useSpring(useTransform(pointerY, [-1, 1], [3, -3]), {
    stiffness: 110,
    damping: 24,
  });

  function trackPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (reduce || !frame.current || event.pointerType === "touch") return;
    const rect = frame.current.getBoundingClientRect();
    pointerX.set(((event.clientX - rect.left) / rect.width) * 2 - 1);
    pointerY.set(((event.clientY - rect.top) / rect.height) * 2 - 1);
  }

  function resetPointer() {
    pointerX.set(0);
    pointerY.set(0);
  }

  return (
    <motion.div
      ref={frame}
      className="q-instrument q-cinematic-instrument"
      aria-label="Simulated agent decision instrument"
      onPointerMove={trackPointer}
      onPointerLeave={resetPointer}
      style={reduce ? undefined : { rotateX, rotateY, transformPerspective: 900 }}
      initial={reduce ? { opacity: 1 } : { opacity: 0, y: 20, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 1, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="q-agent-art" aria-hidden="true">
        <img src="/assets/quorumark-agent-council.png" alt="" />
        <div className="q-art-scan" />
      </div>
      <div className="q-instrument-top">
        <span>Decision instrument</span>
        <span>SIM / 0042</span>
      </div>
      <div className="q-signal-line" aria-hidden="true">
        {[28, 54, 36, 82, 66, 44, 72].map((height, index) => (
          <motion.span
            key={index}
            style={{ height: `${height}%` }}
            animate={reduce ? undefined : { scaleY: [0.72, 1.08, 0.82] }}
            transition={{
              duration: 2.4 + index * 0.14,
              repeat: Infinity,
              delay: index * 0.11,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>
      <div className="q-instrument-main">
        <div className="q-ring q-ring-live" aria-hidden="true">
          <span className="q-ring-arc" />
          <motion.div
            className="q-ring-inner"
            animate={reduce ? undefined : { rotate: [26, 386] }}
            transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
          >
            2<span>/3</span>
          </motion.div>
        </div>
        <div>
          <p className="q-instrument-label">Quorum reached</p>
          <strong>Reserve allocation</strong>
          <p className="q-instrument-muted">Policy check passed · human approval pending</p>
        </div>
      </div>
      <div className="q-agent-strip">
        {agents.map((agent, index) => (
          <motion.div
            key={agent.name}
            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              delay: reduce ? 0 : 0.65 + index * 0.22,
              duration: 0.55,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <span className={`q-agent-index q-agent-${index}`}>0{index + 1}</span>
            {agent.name}
            <b className={`q-agent-vote-${agent.tone}`}>{agent.vote}</b>
          </motion.div>
        ))}
      </div>
      <div className="q-evidence-stream" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
    </motion.div>
  );
}
