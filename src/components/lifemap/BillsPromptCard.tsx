/**
 * Prompt card shown on /paper when the user has no bills yet. Encourages
 * setting up the Life Map — coverage math is what turns paper P&L into a
 * meaningful narrative. Dismissible per-user; the dismissal is persisted.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { X, Target } from "lucide-react";
import {
  dismissBillsPrompt,
  getLifeMapSnapshot,
} from "@/lib/bills/bills.functions";

export function BillsPromptCard() {
  const fetchSnap = useServerFn(getLifeMapSnapshot);
  const dismiss = useServerFn(dismissBillsPrompt);
  const qc = useQueryClient();

  const { data: snap } = useQuery({
    queryKey: ["life-map-snapshot"],
    queryFn: () => fetchSnap(),
    staleTime: 60_000,
  });

  const mut = useMutation({
    mutationFn: () => dismiss(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["life-map-snapshot"] }),
  });

  if (!snap) return null;
  if (snap.prompt_dismissed) return null;
  if (snap.bills.length > 0) return null;

  return (
    <div className="relative overflow-hidden rounded-3xl border border-[#9945FF]/40 bg-gradient-to-br from-[#9945FF]/15 via-black to-black p-5 shadow-[0_0_40px_-12px_#9945FF]">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => mut.mutate()}
        className="absolute right-3 top-3 rounded-full p-1 text-white/50 hover:bg-white/[0.06] hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-[#9945FF]/20 p-2">
          <Target className="h-5 w-5 text-[#9945FF]" />
        </div>
        <div>
          <p className="text-[14px] font-semibold text-white">
            Turn paper gains into a Life Map.
          </p>
          <p className="mt-1 max-w-lg text-[12px] text-white/60">
            Add the bills you want covered — rent, phone, car — and simulated profits
            start flowing to them in priority order. This is paper math only.
          </p>
          <Link
            to="/life-map"
            className="mt-3 inline-block rounded-lg bg-[#9945FF] px-4 py-2 text-[12px] font-semibold text-white shadow-[0_0_20px_-4px_#9945FF] transition hover:brightness-110"
          >
            Set up Life Map
          </Link>
        </div>
      </div>
    </div>
  );
}
