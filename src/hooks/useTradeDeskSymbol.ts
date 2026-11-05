import { useEffect, useState } from "react";
import { useCandidateLifecycle } from "./useCandidateLifecycle";

/** A signal can seed the desk, but must not undo an explicit user selection. */
export function useTradeDeskSymbol(initialSymbol: string | null, candidateId: string | null) {
  const [symbol, setSymbol] = useState(initialSymbol ?? "ETH-USDT");
  const [dismissedCandidateId, setDismissedCandidateId] = useState<string | null>(null);
  const activeCandidateId = candidateId !== dismissedCandidateId ? candidateId : null;
  const { lifecycle } = useCandidateLifecycle(
    activeCandidateId ? { candidateId: activeCandidateId } : { symbol },
  );
  const candidateSymbol = activeCandidateId ? lifecycle?.candidate.symbol : null;

  useEffect(() => {
    if (candidateSymbol) setSymbol(candidateSymbol);
  }, [activeCandidateId, candidateSymbol]);

  function selectSymbol(next: string) {
    setDismissedCandidateId(candidateId);
    setSymbol(next);
  }

  return [symbol, selectSymbol] as const;
}
