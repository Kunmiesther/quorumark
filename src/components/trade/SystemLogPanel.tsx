/**
 * SystemLogPanel — dense read-only tail of `bot_events` for the desk's
 * activity drawer. No writes, no engine interaction.
 */
import { useBotEvents } from "@/hooks/useBotEvents";

function tone(level: string): string {
  const l = level.toLowerCase();
  if (l === "error" || l === "critical") return "var(--onixus-red)";
  if (l === "warn" || l === "warning") return "var(--warning)";
  if (l === "info") return "var(--onixus-hot-blue)";
  return "rgba(230,232,240,0.6)";
}

export function SystemLogPanel({ limit = 60, book }: { limit?: number; book?: "paper" | "live" }) {
  const q = useBotEvents(limit);
  const rows = (q.data ?? []).filter((event) => book !== "live" || !event.event.startsWith("PAPER_"));

  if (q.isLoading) {
    return <p className="py-4 text-center text-[11px] text-white/40">Loading system log…</p>;
  }
  if (q.isError) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-400/20 p-3 text-[11px] text-rose-200">
        <span>System events are unavailable.</span>
        <button type="button" onClick={() => void q.refetch()} className="rounded-lg border border-current/25 px-2 py-1">
          Retry
        </button>
      </div>
    );
  }
  if (rows.length === 0) {
    return <p className="py-4 text-center text-[11px] text-white/40">No {book ?? "system"} events yet</p>;
  }

  return (
    <table className="w-full min-w-[560px] table-fixed text-[11px]" data-testid="system-log">
      <thead className="sticky top-0 bg-[color:var(--surface-1)] text-[9.5px] uppercase tracking-[0.14em] text-white/45">
        <tr>
          <th className="w-28 py-1 pr-3 text-left">Time</th>
          <th className="w-16 py-1 pr-3 text-left">Level</th>
          <th className="w-[42%] py-1 pr-3 text-left">Event</th>
          <th className="py-1 text-left">Details</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {rows.map((e) => (
          <tr key={e.id} className="border-t border-white/[0.05]">
            <td className="whitespace-nowrap py-1 pr-3 tabular-nums text-white/45">
              {new Date(e.created_at).toLocaleTimeString()}
            </td>
            <td className="py-1 pr-3" style={{ color: tone(e.level) }}>
              {e.level}
            </td>
            <td className="break-words py-1 pr-3 text-white/85">{e.event.replaceAll("_", " ")}</td>
            <td className="py-1 text-white/45">
              {e.detail ? (
                <details className="group">
                  <summary className="cursor-pointer select-none text-violet-200/75 hover:text-violet-100">
                    Inspect event
                  </summary>
                  <pre className="mt-2 max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/35 p-2 text-[10px] leading-4 text-white/65">
                    {JSON.stringify(e.detail, null, 2)}
                  </pre>
                </details>
              ) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
