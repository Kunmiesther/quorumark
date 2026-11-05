/**
 * useLiveDecisionFlow — polls the read-only decision projection, asks the
 * committee about the newest decision, and exposes the owner-only diagnostic
 * connectivity check as a separate mutation.
 *
 * None of these paths can place, modify, or cancel an order. The committee
 * call in particular runs in the web process and has no route to the worker,
 * broker, signer or ApeX — so a slow or failing model cannot hold up a trade
 * that a different process already decided.
 */
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  evaluateDecisionCommittee,
  getLiveDecisionFlow,
  runShadowAiCheck,
} from "@/lib/decision/decisionFlow.functions";
import type { DecisionFlowDto } from "@/lib/decision/decisionFlow";
import type { ShadowCheckResult } from "@/lib/decision/shadowCheck.server.types";

export function useLiveDecisionFlow(symbol: string) {
  const flowFn = useServerFn(getLiveDecisionFlow);
  const committeeFn = useServerFn(evaluateDecisionCommittee);
  const checkFn = useServerFn(runShadowAiCheck);
  const queryClient = useQueryClient();

  const query = useQuery<DecisionFlowDto>({
    queryKey: ["decision-flow", symbol],
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: () => flowFn({ data: { symbol } }),
  });

  const decisionId = query.data?.decision?.decisionId ?? null;
  const seatsAsked = (query.data?.opinions ?? []).length;

  // Ask the committee once per decision, when it has not been asked yet.
  // Deliberately fire-and-forget: the flow renders fully without it, and a
  // committee failure only leaves the seats reading "not asked".
  const committee = useMutation({
    mutationFn: (id: string) => committeeFn({ data: { decisionId: id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decision-flow", symbol] });
    },
  });

  const { mutate: askCommittee, isPending: committeePending } = committee;

  useEffect(() => {
    if (!decisionId || seatsAsked > 0 || committeePending) return;
    askCommittee(decisionId);
  }, [decisionId, seatsAsked, committeePending, askCommittee]);

  const check = useMutation<ShadowCheckResult>({
    mutationFn: () => checkFn(undefined as never),
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refresh: () => query.refetch(),
    committeePending,
    check,
  };
}
