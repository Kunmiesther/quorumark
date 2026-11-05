import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { adminListCommunities, adminUpdateCommunity } from "@/lib/community/community.functions";
import { COMMUNITY_PLANS } from "@/lib/community/communityPlans";

export const Route = createFileRoute("/_authenticated/admin/communities")({
  component: OnixusControlCenter,
  head: () => ({
    meta: [
      { title: "Onixus Control Center — Communities" },
      { name: "description", content: "Approve, suspend and seat TurtleBot communities. Onixus admin only." },
      { property: "og:title", content: "Onixus Control Center — Communities" },
      { property: "og:description", content: "Community applications, seats, plans and audit history." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function OnixusControlCenter() {
  const qc = useQueryClient();
  const list = useServerFn(adminListCommunities);
  const update = useServerFn(adminUpdateCommunity);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "communities"],
    queryFn: () => list(),
  });

  const mutate = useMutation({
    mutationFn: (input: Parameters<typeof adminUpdateCommunity>[0]["data"]) => update({ data: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "communities"] }),
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading communities…</div>;
  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      <div className="mx-auto mt-10 max-w-lg rounded-xl border border-red-500/40 bg-red-500/5 p-6">
        <h1 className="text-base font-semibold text-red-400">
          {/Forbidden/i.test(msg) ? "Admin access required" : "Failed to load communities"}
        </h1>
        <p className="mt-2 text-xs text-muted-foreground">{msg}</p>
      </div>
    );
  }

  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Onixus Control Center</h1>
          <p className="text-sm text-muted-foreground">
            Community applications, seats and plans. Live trading is never granted here.
          </p>
        </div>
        <Link
          to="/admin/broadcast"
          className="shrink-0 rounded-lg border border-border/60 px-3 py-2 text-xs font-semibold text-foreground hover:bg-white/[0.04]"
        >
          Broadcast →
        </Link>
      </header>

      <div className="overflow-x-auto rounded-xl border border-border/60">
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Community</th>
              <th className="px-3 py-2">Contact</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Seats</th>
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-border/40 align-middle">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{c.name}</div>
                  <div className="text-muted-foreground">/{c.slug}</div>
                </td>
                <td className="px-3 py-2">{c.applicant_email}</td>
                <td className="px-3 py-2">{c.status}</td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={0}
                    defaultValue={c.seat_limit}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== c.seat_limit) mutate.mutate({ communityId: c.id, seatLimit: v });
                    }}
                    className="w-20 rounded border border-border/60 bg-background/60 px-2 py-1"
                  />
                  <span className="ml-2 text-muted-foreground">{c.seats_used} used</span>
                </td>
                <td className="px-3 py-2">
                  <select
                    defaultValue={c.plan_key}
                    onChange={(e) => mutate.mutate({ communityId: c.id, planKey: e.target.value })}
                    className="rounded border border-border/60 bg-background/60 px-2 py-1"
                  >
                    {Object.values(COMMUNITY_PLANS).map((p) => (
                      <option key={p.key} value={p.key}>{p.name}</option>
                    ))}
                  </select>
                </td>
                <td className="space-x-2 px-3 py-2">
                  {c.status !== "approved" && (
                    <button className="text-emerald-400 hover:underline" onClick={() => mutate.mutate({ communityId: c.id, status: "approved" })}>
                      Approve
                    </button>
                  )}
                  {c.status === "approved" && (
                    <button className="text-amber-400 hover:underline" onClick={() => mutate.mutate({ communityId: c.id, status: "suspended" })}>
                      Suspend
                    </button>
                  )}
                  <button className="text-red-400 hover:underline" onClick={() => mutate.mutate({ communityId: c.id, status: "revoked" })}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td className="px-3 py-4 text-muted-foreground" colSpan={6}>No community applications yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
