// One authoritative subscription to the selected candidate's lifecycle.
//
// This hook is the only place the desk asks for candidate state. It does not
// poll prices and does not duplicate any execution-state query — order state
// arrives with the lifecycle row itself.
//
// Selection is by candidate id when one is supplied; symbol is only a
// discovery convenience for surfaces that have no selection yet. The query key
// carries the selection, so switching candidates cannot render a mixed frame:
// the previous result is dropped rather than reused.

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getCandidateLifecycle,
  requestShadowEvaluation,
} from "@/lib/candidate/lifecycle.functions";
import { candidateFreshness, type CandidateLifecycleDto } from "@/lib/candidate/lifecycle";

/** A candidate older than this is presented as historical, never as current. */
const STALE_AFTER_MS = 15 * 60_000;

export interface CandidateSelection {
  /** Authoritative when present. No latest-by-symbol fallback is applied. */
  candidateId?: string | null;
  symbol?: string | null;
}

export interface CandidateLifecycleView {
  lifecycle: CandidateLifecycleDto | null;
  isLoading: boolean;
  /** "current" | "stale" | null when there is no candidate at all. */
  freshness: "current" | "stale" | null;
  evaluating: boolean;
  /** Stable key for the current selection — use it to key rendered frames. */
  selectionKey: string;
}

export function useCandidateLifecycle(
  selection: CandidateSelection | string | null | undefined,
): CandidateLifecycleView {
  const sel: CandidateSelection =
    typeof selection === "string" ? { symbol: selection } : (selection ?? {});
  const candidateId = sel.candidateId ?? null;
  const symbol = candidateId ? null : (sel.symbol ?? null);
  const selectionKey = candidateId ? `id:${candidateId}` : symbol ? `sym:${symbol}` : "none";

  const fetchLifecycle = useServerFn(getCandidateLifecycle);
  const evaluate = useServerFn(requestShadowEvaluation);
  const queryClient = useQueryClient();
  const requested = useRef<Set<string>>(new Set());

  const q = useQuery({
    queryKey: ["candidate-lifecycle", selectionKey],
    queryFn: () => fetchLifecycle({ data: { candidateId, symbol } }),
    enabled: selectionKey !== "none",
    refetchInterval: 30_000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: (id: string) => evaluate({ data: { candidateId: id } }),
    // Bounded: one transient retry. Auth/schema failures are not retried —
    // the persisted outcome already records the exact reason.
    retry: 1,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["candidate-lifecycle", selectionKey] });
      queryClient.invalidateQueries({ queryKey: ["candidate-feed"] });
    },
  });

  const lifecycle = q.data ?? null;
  const candidate = lifecycle?.candidate ?? null;
  const needsEvaluation =
    candidate != null &&
    lifecycle?.evaluation == null &&
    candidate.aiShadowState === "ai_shadow_pending";

  useEffect(() => {
    if (!needsEvaluation || !candidate) return;
    // Exactly-once per evidence hash for this session; the server side is
    // durably idempotent regardless, so a remount cannot double-spend.
    const key = `${candidate.candidateId}:${candidate.evidenceHash}`;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    mutation.mutate(candidate.candidateId);
  }, [needsEvaluation, candidate, mutation]);

  return {
    lifecycle,
    isLoading: q.isLoading,
    freshness: candidate ? candidateFreshness(candidate, Date.now(), STALE_AFTER_MS) : null,
    evaluating: mutation.isPending,
    selectionKey,
  };
}
