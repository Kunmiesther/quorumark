/** Read-only panel: last 50 sanitized venue rejections (owner-scoped). */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listVenueRejections } from "@/lib/ops/venueRejections.functions";

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="px-2 py-1.5 align-top whitespace-nowrap">{children}</td>;
}

export function VenueRejectionsPanel() {
  const fetchRows = useServerFn(listVenueRejections);
  const { data, isLoading, error } = useQuery({
    queryKey: ["venue-rejections"],
    queryFn: () => fetchRows(),
    refetchInterval: 30_000,
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3">
        <h2 className="text-sm font-semibold tracking-wide text-foreground">
          Venue Rejections (sanitized, durable)
        </h2>
        <p className="text-xs text-muted-foreground">
          Survives signer container rotation. Read-only — no order is created,
          modified, or cancelled from this panel.
        </p>
      </header>

      {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-xs text-destructive">Unable to load rejections.</p>
      )}
      {data && data.length === 0 && (
        <p className="text-xs text-muted-foreground">No rejections recorded.</p>
      )}

      {data && data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="px-2 py-1.5 font-medium">When</th>
                <th className="px-2 py-1.5 font-medium">Symbol</th>
                <th className="px-2 py-1.5 font-medium">Side / Type</th>
                <th className="px-2 py-1.5 font-medium">Size @ Price</th>
                <th className="px-2 py-1.5 font-medium">HTTP</th>
                <th className="px-2 py-1.5 font-medium">Venue code</th>
                <th className="px-2 py-1.5 font-medium">Category</th>
                <th className="px-2 py-1.5 font-medium">Safe message</th>
                <th className="px-2 py-1.5 font-medium">Signer map</th>
                <th className="px-2 py-1.5 font-medium">Revision</th>
                <th className="px-2 py-1.5 font-medium">Correlation</th>
              </tr>
            </thead>
            <tbody className="text-foreground">
              {data.map((r) => (
                <tr key={`${r.idempotency_key}-${r.observed_at}`} className="border-t border-border/60">
                  <Cell>{new Date(r.observed_at).toLocaleString()}</Cell>
                  <Cell>{r.symbol ?? "—"}</Cell>
                  <Cell>{[r.side, r.order_type].filter(Boolean).join(" / ") || "—"}</Cell>
                  <Cell>
                    {r.requested_size ?? "—"}
                    {r.requested_price !== null ? ` @ ${r.requested_price}` : ""}
                  </Cell>
                  <Cell>{r.http_status ?? "—"}</Cell>
                  <Cell>{r.venue_code ?? "—"}</Cell>
                  <Cell>{r.venue_category ?? "—"}</Cell>
                  <Cell>{r.venue_message ?? "—"}</Cell>
                  <Cell>{r.signer_mapping ?? r.reject_reason ?? "—"}</Cell>
                  <Cell>{r.signer_revision ?? "—"}</Cell>
                  <Cell>{r.idempotency_key ?? "—"}</Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
