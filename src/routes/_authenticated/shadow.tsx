/**
 * /shadow — Live/Paper Shadow Mode surface.
 *
 * Read-only view over `paper_live_shadow_ledger`. Owner-gated by the RLS
 * policy on the table: admins see every row, users see their own. No
 * business logic here — the worker writes; this route only reads.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/shadow")({
  component: ShadowPage,
  head: () => ({
    meta: [
      { title: "Shadow Mode — TurtleBot" },
      { name: "description", content: "Side-by-side comparison of every strategy decision as the paper engine and the live worker take it in parallel." },
      { property: "og:title", content: "Shadow Mode — TurtleBot" },
      { property: "og:description", content: "Live/paper decision parity ledger." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

interface ShadowRow {
  id: string;
  observed_at: string;
  symbol: string;
  leg: string;
  direction: "long" | "short";
  directive_type: string;
  comparison_status: "paper_only" | "live_only" | "in_line" | "divergent";
  divergence_reason: string | null;
  paper_price: number | null;
  live_price: number | null;
  price_delta_bps: number | null;
}

function useShadowLedger() {
  return useQuery({
    queryKey: ["shadow-ledger"],
    queryFn: async (): Promise<ShadowRow[]> => {
      // Types for paper_live_shadow_ledger regenerate after the migration
      // runs; cast via unknown until the generated types include it.
      const { data, error } = await (supabase.from as unknown as (t: string) => {
        select: (cols: string) => {
          order: (col: string, opts: { ascending: boolean }) => {
            limit: (n: number) => Promise<{ data: ShadowRow[] | null; error: unknown }>;
          };
        };
      })("paper_live_shadow_ledger")
        .select("id,observed_at,symbol,leg,direction,directive_type,comparison_status,divergence_reason,paper_price,live_price,price_delta_bps")
        .order("observed_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as ShadowRow[];
    },
    refetchInterval: 15_000,
  });
}

function StatusBadge({ status }: { status: ShadowRow["comparison_status"] }) {
  const map: Record<ShadowRow["comparison_status"], string> = {
    paper_only: "bg-muted text-muted-foreground",
    live_only: "bg-amber-500/20 text-amber-300",
    in_line: "bg-emerald-500/20 text-emerald-300",
    divergent: "bg-rose-500/20 text-rose-300",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${map[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function ShadowPage() {
  const { data, isLoading, error } = useShadowLedger();

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Shadow Mode</h1>
        <p className="text-sm text-muted-foreground">
          Every strategy decision recorded by the paper engine and — once
          live activates — the parallel decision the live worker took.
          Rows are compared within the configured price tolerance and
          flagged{" "}
          <span className="font-medium text-emerald-400">in line</span> or{" "}
          <span className="font-medium text-rose-400">divergent</span>.
        </p>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading ledger…</p>}
      {error && <p className="text-sm text-rose-400">Could not load ledger.</p>}

      {data && data.length === 0 && (
        <div className="rounded-lg border border-border/60 bg-card/40 p-6 text-sm text-muted-foreground">
          No decisions recorded yet. Rows appear as soon as the worker runs
          its next cycle.
        </div>
      )}

      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-card/60 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">When</th>
                <th className="p-2">Symbol</th>
                <th className="p-2">Leg</th>
                <th className="p-2">Side</th>
                <th className="p-2">Directive</th>
                <th className="p-2">Paper px</th>
                <th className="p-2">Live px</th>
                <th className="p-2">Δ bps</th>
                <th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="border-t border-border/40">
                  <td className="p-2 text-xs">{new Date(r.observed_at).toLocaleString()}</td>
                  <td className="p-2 font-medium">{r.symbol}</td>
                  <td className="p-2">{r.leg}</td>
                  <td className="p-2">{r.direction}</td>
                  <td className="p-2">{r.directive_type}</td>
                  <td className="p-2 tabular-nums">{r.paper_price ?? "—"}</td>
                  <td className="p-2 tabular-nums">{r.live_price ?? "—"}</td>
                  <td className="p-2 tabular-nums">{r.price_delta_bps ?? "—"}</td>
                  <td className="p-2">
                    <StatusBadge status={r.comparison_status} />
                    {r.divergence_reason && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {r.divergence_reason}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
