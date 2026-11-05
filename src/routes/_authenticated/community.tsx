import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getMyAccess } from "@/lib/community/access.functions";
import {
  createInvitation,
  getLeaderDashboard,
  listCommunityInvitations,
  revokeInvitation,
} from "@/lib/community/community.functions";
import {
  joinCommunityCompetition,
  listCompetitionLeaderboard,
  listMyCommunityCompetitions,
  refreshCompetitionScores,
} from "@/lib/community/competition.functions";

export const Route = createFileRoute("/_authenticated/community")({
  component: CommunityCommandCenter,
  head: () => ({
    meta: [
      { title: "Community Command Center — TurtleBot" },
      { name: "description", content: "Manage your TurtleBot community: seats, invitations, funnel and commission ledger." },
      { property: "og:title", content: "Community Command Center — TurtleBot" },
      { property: "og:description", content: "Seats, invitations, funnel and commission ledger for community leaders." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function CommunityCommandCenter() {
  const fetchAccess = useServerFn(getMyAccess);
  const access = useQuery({ queryKey: ["access", "me"], queryFn: () => fetchAccess() });

  const leaderCommunity = access.data?.communities.find((c) => c.role === "leader");
  const memberCommunity = access.data?.communities[0];

  if (access.isLoading) return <Shell><p className="text-sm text-muted-foreground">Loading…</p></Shell>;
  if (!memberCommunity) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Community Command Center</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You are not enrolled in a TurtleBot community yet. Competition access is invitation-only.
        </p>
      </Shell>
    );
  }

  if (!access.data?.leader || !leaderCommunity) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Community</h1>
        <p className="mb-6 text-sm text-muted-foreground">Private competitions and community standings.</p>
        <CommunityCompetitions communityId={memberCommunity.id} isLeader={false} />
      </Shell>
    );
  }

  return <LeaderPanel communityId={leaderCommunity.id} />;
}

function LeaderPanel({ communityId }: { communityId: string }) {
  const qc = useQueryClient();
  const fetchDash = useServerFn(getLeaderDashboard);
  const fetchInvites = useServerFn(listCommunityInvitations);
  const createFn = useServerFn(createInvitation);
  const revokeFn = useServerFn(revokeInvitation);

  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const dash = useQuery({ queryKey: ["community", communityId, "dash"], queryFn: () => fetchDash({ data: { communityId } }) });
  const invites = useQuery({ queryKey: ["community", communityId, "invites"], queryFn: () => fetchInvites({ data: { communityId } }) });

  const create = useMutation({
    mutationFn: () => createFn({ data: { communityId, email: email || null, maxUses } }),
    onSuccess: (res) => {
      setIssuedToken(res.token);
      setError(null);
      setEmail("");
      qc.invalidateQueries({ queryKey: ["community", communityId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not create invitation."),
  });

  const revoke = useMutation({
    mutationFn: (invitationId: string) => revokeFn({ data: { invitationId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["community", communityId] }),
  });

  const f = dash.data?.funnel;

  return (
    <Shell>
      <header className="mb-6">
        <h1 className="text-xl font-semibold">{(dash.data?.community as { name?: string } | null)?.name ?? "Community"}</h1>
        <p className="text-sm text-muted-foreground">Seats, invitations and community health.</p>
      </header>

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Seats used" value={`${f?.seatsUsed ?? 0} / ${f?.seatLimit ?? 0}`} />
        <Stat label="Invites created" value={f?.invitesCreated ?? 0} />
        <Stat label="Redeemed" value={f?.invitesRedeemed ?? 0} />
        <Stat label="Outstanding" value={f?.invitesOutstanding ?? 0} />
      </div>

      {dash.data?.cohortTooSmall && (
        <p className="mb-6 rounded-lg border border-border/60 bg-background/40 p-3 text-xs text-muted-foreground">
          Aggregate member performance is hidden until at least {dash.data.minCohort} members are
          active, so individual results stay private.
        </p>
      )}

      <CommunityCompetitions communityId={communityId} isLeader />

      <section className="mb-8 rounded-xl border border-border/60 p-4">
        <h2 className="mb-3 text-sm font-semibold">Create an invitation</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted-foreground">
            Lock to email (optional)
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="member@example.com"
              className="mt-1 block w-64 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Seats on this link
            <input
              type="number"
              min={1}
              value={maxUses}
              onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))}
              className="mt-1 block w-28 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground"
            />
          </label>
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {create.isPending ? "Creating…" : "Create invitation"}
          </button>
        </div>
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        {issuedToken && (
          <div className="mt-4 rounded-lg border border-primary/40 bg-primary/5 p-3">
            <p className="text-xs text-muted-foreground">
              Copy this link now — it is shown once and never stored in readable form.
            </p>
            <code className="mt-1 block break-all text-xs text-foreground">
              {typeof window !== "undefined" ? window.location.origin : ""}/invite/{issuedToken}
            </code>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold">Invitations</h2>
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <Th>Email</Th><Th>Uses</Th><Th>Expires</Th><Th>State</Th><Th />
              </tr>
            </thead>
            <tbody>
              {(invites.data ?? []).map((i) => {
                const expired = new Date(i.expires_at).getTime() <= Date.now();
                const state = i.revoked_at ? "revoked" : expired ? "expired" : i.uses >= i.max_uses ? "exhausted" : "active";
                return (
                  <tr key={i.id} className="border-t border-border/40">
                    <Td>{i.email ?? "— any"}</Td>
                    <Td>{i.uses} / {i.max_uses}</Td>
                    <Td>{new Date(i.expires_at).toLocaleDateString()}</Td>
                    <Td>{state}</Td>
                    <Td>
                      {state === "active" && (
                        <button onClick={() => revoke.mutate(i.id)} className="text-red-400 hover:underline">
                          Revoke
                        </button>
                      )}
                    </Td>
                  </tr>
                );
              })}
              {(invites.data ?? []).length === 0 && (
                <tr><Td>No invitations yet.</Td><Td /><Td /><Td /><Td /></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Commission ledger</h2>
        {(dash.data?.ledger ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No commission entries. No payment provider is connected, so nothing can be accrued yet.
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {(dash.data?.ledger as Array<{ id: string; period_start: string; amount_cents: number; currency: string }>).map((l) => (
              <li key={l.id}>
                {l.period_start} — {(l.amount_cents / 100).toFixed(2)} {l.currency}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}

function CommunityCompetitions({ communityId, isLeader }: { communityId: string; isLeader: boolean }) {
  const queryClient = useQueryClient();
  const listCompetitions = useServerFn(listMyCommunityCompetitions);
  const listLeaderboard = useServerFn(listCompetitionLeaderboard);
  const joinCompetition = useServerFn(joinCommunityCompetition);
  const refreshScores = useServerFn(refreshCompetitionScores);
  const [selectedId, setSelectedId] = useState("");
  const [leaderboardName, setLeaderboardName] = useState("");

  const competitions = useQuery({
    queryKey: ["community", communityId, "competitions"],
    queryFn: () => listCompetitions({ data: { communityId } }),
  });
  const selected = competitions.data?.find((item) => item.id === selectedId) ?? competitions.data?.[0];
  const leaderboard = useQuery({
    queryKey: ["competition", selected?.id, "leaderboard"],
    enabled: Boolean(selected?.id),
    queryFn: () => listLeaderboard({ data: { competitionId: selected!.id } }),
  });
  const enrolled = leaderboard.data?.some((entry) => entry.is_current_user) ?? false;

  const join = useMutation({
    mutationFn: () => joinCompetition({ data: { competitionId: selected!.id, leaderboardName, rulesVersion: selected!.rules_version } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["competition", selected?.id] }),
  });
  const refresh = useMutation({
    mutationFn: () => refreshScores({ data: { competitionId: selected!.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["competition", selected?.id] }),
  });

  if (competitions.isLoading) return <p className="mb-8 text-xs text-muted-foreground">Loading private competitions…</p>;
  if (!selected) {
    return (
      <section className="mb-8 rounded-xl border border-border/60 p-4">
        <h2 className="text-sm font-semibold">Paper competition</h2>
        <p className="mt-2 text-xs text-muted-foreground">No private competition is open for this community yet.</p>
      </section>
    );
  }

  return (
    <section className="mb-8 rounded-xl border border-primary/30 bg-primary/[0.025] p-4 shadow-[8px_8px_18px_rgba(0,0,0,0.34),-4px_-4px_12px_rgba(255,255,255,0.025)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Private community competition</p>
          <h2 className="mt-1 text-base font-semibold">{selected.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {new Date(selected.starts_at).toLocaleDateString()}–{new Date(selected.ends_at).toLocaleDateString()} · $2,000 simulated · 200 seats
          </p>
        </div>
        <span className="rounded-full border border-primary/30 px-2.5 py-1 text-[10px] uppercase tracking-wide text-primary">{selected.status}</span>
      </div>

      {(competitions.data?.length ?? 0) > 1 ? (
        <select value={selected.id} onChange={(event) => setSelectedId(event.target.value)} className="mt-3 w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground">
          {competitions.data?.map((competition) => <option key={competition.id} value={competition.id}>{competition.name}</option>)}
        </select>
      ) : null}

      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
        <Stat label="1st" value="$300" />
        <Stat label="2nd" value="$150" />
        <Stat label="3rd" value="$50" />
      </div>

      {!enrolled && selected.status === "enrollment" ? (
        <div className="mt-4 rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground">Choose the public name shown on the private leaderboard. Joining confirms rules version {selected.rules_version}.</p>
          <div className="mt-2 flex gap-2">
            <input value={leaderboardName} onChange={(event) => setLeaderboardName(event.target.value)} maxLength={40} placeholder="Leaderboard name" className="min-w-0 flex-1 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground" />
            <button type="button" disabled={leaderboardName.trim().length < 2 || join.isPending} onClick={() => join.mutate()} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">Join</button>
          </div>
          {join.data && !join.data.ok ? <p className="mt-2 text-xs text-red-400">Could not join: {join.data.reason.replaceAll("_", " ").toLowerCase()}.</p> : null}
        </div>
      ) : null}

      <div className="mt-5 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Leaderboard</h3>
        {isLeader ? <button type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()} className="rounded-lg border border-border/60 px-2.5 py-1.5 text-xs text-foreground disabled:opacity-50">{refresh.isPending ? "Refreshing…" : "Refresh scores"}</button> : null}
      </div>
      <ol className="mt-2 space-y-2">
        {(leaderboard.data ?? []).slice(0, 20).map((entry, index) => (
          <li key={entry.entry_id} className="grid grid-cols-[2rem_1fr_auto] items-center gap-2 rounded-lg border border-border/40 px-3 py-2 text-xs">
            <span className="text-muted-foreground">#{index + 1}</span>
            <span className="font-medium text-foreground">{entry.leaderboard_name}</span>
            <span className="text-right"><b>{entry.score == null ? "—" : Number(entry.score).toFixed(2)}</b><small className="ml-2 text-muted-foreground">{entry.closed_trade_count ?? 0} trades</small></span>
          </li>
        ))}
      </ol>
      {(leaderboard.data ?? []).length === 0 ? <p className="mt-2 text-xs text-muted-foreground">No members have enrolled yet.</p> : null}
      <p className="mt-4 text-[11px] text-muted-foreground">Paper trading only. No entry fee or deposits. Simulated balances have no cash value. Final standings require an integrity review. Apple and Google are not sponsors.</p>
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl p-6">{children}</div>;
}
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border/60 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}
function Td({ children }: { children?: React.ReactNode }) {
  return <td className="px-3 py-2">{children}</td>;
}
