import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

type ReadResult = { ok?: boolean; skipped?: string; reason?: string; position_snapshot_ok?: boolean };

/** Venue reads only. Reload saved rows even after a partial read failure. */
export function RefreshPositionsButton({ book = "live" }: { book?: "live" | "paper" }) {
  const { user } = useAuth();
  const queries = useQueryClient();
  const refresh = useMutation({
    mutationFn: async () => {
      let failure: Error | undefined;
      let warning: string | undefined;
      try {
        if (book === "live") {
          const { data, error } = await supabase.functions.invoke("reconcile-live-positions", { body: {} });
          if (error || data?.ok !== true || !Array.isArray(data.results)) {
            throw new Error("Exchange position refresh failed. Previous data is still shown.");
          }
          const rows = data.results as ReadResult[];
          if (rows.some(row => row.skipped || (row.ok !== true && row.position_snapshot_ok !== true))) {
            throw new Error("Some exchange positions could not be refreshed. Previous data may still be shown.");
          }
          if (rows.some(row => row.reason === "ORDER_RECONCILIATION_REQUIRED")) {
            warning = "Positions refreshed. ApeX order reconciliation is still required.";
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Position refresh failed.");
      }
      await Promise.all([
        queries.invalidateQueries({ queryKey: ["open-positions", book, user?.id] }),
        ...(book === "live" ? [
          queries.invalidateQueries({ queryKey: ["home-positions", user?.id] }),
          queries.invalidateQueries({ queryKey: ["dashboard-positions", user?.id] }),
          queries.invalidateQueries({ queryKey: ["exchange-summaries", user?.id] }),
          queries.invalidateQueries({ queryKey: ["exchange-connections-list", user?.id] }),
        ] : []),
      ]);
      if (failure) throw failure;
      return warning;
    },
  });
  return (
    <div className="text-right">
      <button type="button" disabled={!user || refresh.isPending}
        onClick={() => refresh.mutate()}
        aria-label="Refresh open positions"
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-cyan-200 hover:bg-white/5 disabled:opacity-50">
        <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${refresh.isPending ? "animate-spin" : ""}`} />
        {refresh.isPending ? "Refreshing…" : "Refresh"}
      </button>
      <p role="status" className="max-w-64 text-[10px] text-white/60">
        {refresh.isError ? refresh.error.message : refresh.isSuccess ? (refresh.data ?? "Positions refreshed.") : ""}
      </p>
    </div>
  );
}

