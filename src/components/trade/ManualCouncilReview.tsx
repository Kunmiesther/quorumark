import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { reviewManualTicket, type ManualCouncilDraft } from "@/lib/ai/manualCouncil.functions";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";

export function useManualCouncil(draft: ManualCouncilDraft) {
  const request = useServerFn(reviewManualTicket);
  const key = JSON.stringify(draft);
  const [result, setResult] = useState<{
    key: string;
    time: number;
    review: CommitteeEvaluationDto;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = result?.key === key && Date.now() - result.time < 300_000 ? result.review : null;
  async function ask() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const review = await request({ data: draft });
      setResult({ key, review, time: Date.now() });
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Council request failed. Retry the review.",
      );
    } finally {
      setPending(false);
    }
  }
  return {
    ready: Boolean(current),
    pending,
    ask,
    panel: (
      <section
        className="tb-neu-inset rounded-xl p-3 text-xs"
        aria-label="Manual Council review"
        aria-live="polite"
      >
        <p className="font-semibold text-violet-200">Council review · before submission</p>
        <p className="mt-1 text-white/50">
          Review does not place an order. Changing this ticket requires a new review.
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => void ask()}
          className="tb-neu-raised mt-2 rounded-lg px-3 py-2 text-violet-100 disabled:opacity-50"
        >
          {pending ? "Council is reviewing…" : "Call Council"}
        </button>
        {error && (
          <p role="alert" className="mt-2 text-amber-200">
            {error}
          </p>
        )}
        {current && (
          <div className="mt-2 space-y-2">
            <p>{current.availableRoles.length}/3 seats answered · advisory only</p>
            {current.outcomes.map((outcome) => (
              <p
                key={outcome.role}
                className={outcome.available ? "text-white/75" : "text-amber-200"}
              >
                {outcome.role}:{" "}
                {outcome.available
                  ? outcome.response.summary
                  : `${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ""}`}
              </p>
            ))}
            <p className="text-white/50">
              Review recorded. Read the findings before proceeding; a failed seat is not approval.
            </p>
          </div>
        )}
      </section>
    ),
  };
}
