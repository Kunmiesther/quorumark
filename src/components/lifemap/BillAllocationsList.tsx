/**
 * Recent allocations for a single bill — expanded from a bill card on
 * /life-map. Lazily fetches on mount; keeps the query cached under
 * ["bill-allocations", bill_id] so re-opening the same card is instant.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getAllocationsForBill } from "@/lib/bills/bills.functions";

function fmtSignedUsd(n: number): string {
  const s = n < 0 ? "−" : "+";
  return `${s}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function relTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function BillAllocationsList({ billId }: { billId: string }) {
  const fetchFn = useServerFn(getAllocationsForBill);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["bill-allocations", billId],
    queryFn: () => fetchFn({ data: { bill_id: billId, limit: 10 } }),
    staleTime: 30_000,
  });

  if (isLoading) {
    return <p className="mt-3 text-[10px] uppercase tracking-widest text-white/40">Loading…</p>;
  }
  if (isError) {
    return <p className="mt-3 text-[10px] text-[#ff5c8a]">Couldn't load allocations.</p>;
  }
  if (!data || data.length === 0) {
    return (
      <p className="mt-3 text-[10px] uppercase tracking-widest text-white/40">
        No allocations yet — closed trades will fund this bill in priority order.
      </p>
    );
  }
  return (
    <ul className="mt-3 space-y-1 border-t border-white/[0.06] pt-3">
      {data.map((r, i) => (
        <li
          key={r.trade_id ? `${r.trade_id}-${i}` : `manual-${i}`}
          className="flex items-center justify-between gap-2 font-mono text-[10.5px] tabular-nums"
        >
          <span className="truncate text-white/60">
            {r.symbol ?? "manual"}
            {r.direction ? <span className="text-white/35"> · {r.direction}</span> : null}
          </span>
          <span className={r.amount_usd >= 0 ? "text-[#14F195]" : "text-[#ff5c8a]"}>
            {fmtSignedUsd(r.amount_usd)}
          </span>
          <span className="w-16 shrink-0 text-right text-white/40">{relTime(r.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}
