/**
 * Surfaces surplus-reallocation suggestions: a bill accumulated more than
 * it needs, and the excess can fully cover one or more smaller uncovered
 * bills. Same "Apply" action a user can also trigger from Telegram
 * (identical server functions, so state stays consistent either way).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRightLeft, X } from "lucide-react";
import { toast } from "sonner";
import {
  applyReallocationSuggestion,
  dismissReallocationSuggestion,
  listPendingReallocationSuggestions,
} from "@/lib/bills/reallocation.functions";

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ReallocationSuggestionBanner() {
  const qc = useQueryClient();
  const fetchSuggestions = useServerFn(listPendingReallocationSuggestions);
  const applyFn = useServerFn(applyReallocationSuggestion);
  const dismissFn = useServerFn(dismissReallocationSuggestion);

  const { data: suggestions } = useQuery({
    queryKey: ["reallocation-suggestions"],
    queryFn: () => fetchSuggestions(),
    staleTime: 30_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["reallocation-suggestions"] });
    qc.invalidateQueries({ queryKey: ["life-map-snapshot"] });
  };

  const apply = useMutation({
    mutationFn: (id: string) => applyFn({ data: { id } }),
    onSuccess: (res) => {
      invalidate();
      toast[res.ok ? "success" : "error"](
        res.ok ? "Applied — bills updated." : "That surplus is no longer available.",
      );
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not apply."),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissFn({ data: { id } }),
    onSuccess: invalidate,
  });

  if (!suggestions || suggestions.length === 0) return null;

  return (
    <div className="mt-4 space-y-2.5">
      {suggestions.map((s) => (
        <div
          key={s.id}
          className="relative overflow-hidden rounded-2xl border border-[#14F195]/40 bg-gradient-to-br from-[#14F195]/10 via-black to-black p-4"
        >
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss.mutate(s.id)}
            disabled={dismiss.isPending || apply.isPending}
            className="absolute right-3 top-3 rounded-full p-1 text-white/50 hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-start gap-3 pr-6">
            <div className="rounded-xl bg-[#14F195]/20 p-2">
              <ArrowRightLeft className="h-5 w-5 text-[#14F195]" />
            </div>
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold text-white">
                <span className="text-[#14F195]">{s.source_bill_name}</span> has {fmtUsd(s.surplus_usd)} more than
                it needs.
              </p>
              <p className="mt-1 text-[12px] text-white/60">
                That covers{" "}
                {s.targets.map((t, i) => (
                  <span key={t.bill_id}>
                    {i > 0 ? (i === s.targets.length - 1 ? " and " : ", ") : ""}
                    <span className="text-white/80">{t.bill_name}</span> ({fmtUsd(t.amount_usd)})
                  </span>
                ))}
                .
              </p>
              <button
                type="button"
                onClick={() => apply.mutate(s.id)}
                disabled={apply.isPending || dismiss.isPending}
                className="mt-3 rounded-lg bg-[#14F195] px-4 py-2 text-[12px] font-semibold text-black shadow-[0_0_20px_-4px_#14F195] transition hover:brightness-110 disabled:opacity-60"
              >
                {apply.isPending ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
