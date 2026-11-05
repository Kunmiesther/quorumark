import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ImagePlus, Trophy, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { broadcastTelegramAnnouncement, listBroadcastTargets } from "@/lib/telegram/broadcast.functions";
import { adminListCommunities } from "@/lib/community/community.functions";
import {
  adminCreateCommunityCompetition,
  adminListCommunityCompetitions,
} from "@/lib/community/competition.functions";

export const Route = createFileRoute("/_authenticated/admin/broadcast")({
  component: BroadcastPage,
  head: () => ({
    meta: [
      { title: "Onixus Control Center — Campaign Manager" },
      { name: "robots", content: "noindex" },
      { name: "description", content: "Send a Telegram announcement to every linked account. Onixus admin only." },
    ],
  }),
});

// Telegram truncates a photo caption at 1024 chars, vs 3500 for a plain
// text message — cap input accordingly once an image is attached so
// nothing gets silently cut off after sending.
const TEXT_MAX = 3500;
const CAPTION_MAX = 1024;

function BroadcastPage() {
  const send = useServerFn(broadcastTelegramAnnouncement);
  const listTargets = useServerFn(listBroadcastTargets);
  const listCommunities = useServerFn(adminListCommunities);
  const listCompetitions = useServerFn(adminListCommunityCompetitions);
  const createCompetition = useServerFn(adminCreateCommunityCompetition);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sendToIndividuals, setSendToIndividuals] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<Set<number>>(new Set());
  const [selectedCompetitionId, setSelectedCompetitionId] = useState("");
  const [campaignPhase, setCampaignPhase] = useState<CampaignPhase>("launch");

  const targetsQuery = useQuery({
    queryKey: ["telegram-broadcast-targets"],
    queryFn: () => listTargets(),
  });
  const groups = targetsQuery.data ?? [];
  const communitiesQuery = useQuery({ queryKey: ["admin", "communities"], queryFn: () => listCommunities() });
  const competitionsQuery = useQuery({ queryKey: ["admin", "competitions"], queryFn: () => listCompetitions() });
  const competitions = competitionsQuery.data ?? [];

  const maxLen = imageUrl ? CAPTION_MAX : TEXT_MAX;

  const mutate = useMutation({
    mutationFn: () =>
      send({
        data: {
          message,
          imageUrl: imageUrl ?? undefined,
          sendToIndividuals,
          groupChatIds: Array.from(selectedGroups),
          competitionId: selectedCompetitionId || undefined,
          campaignPhase: selectedCompetitionId ? campaignPhase : undefined,
        },
      }),
    onSuccess: () => {
      setMessage("");
      setImageUrl(null);
      setConfirming(false);
    },
  });

  const noAudience = !sendToIndividuals && selectedGroups.size === 0;

  const errMsg = mutate.error instanceof Error ? mutate.error.message : null;
  const forbidden = errMsg ? /Forbidden/i.test(errMsg) : false;

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadError(null);
    if (file.size > 10 * 1024 * 1024) {
      setUploadError("Image must be under 10MB");
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from("broadcast-images")
        .upload(path, file, { contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from("broadcast-images").getPublicUrl(path);
      setImageUrl(data.publicUrl);
      setConfirming(false);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Campaign Manager</h1>
        <p className="text-sm text-muted-foreground">
          Create the private paper competition, then send its launch and update messages to a registered community group.
        </p>
      </header>

      <CompetitionSetup
        communities={communitiesQuery.data ?? []}
        competitions={competitions}
        createCompetition={createCompetition}
        onCreated={(id) => {
          setSelectedCompetitionId(id);
          void competitionsQuery.refetch();
        }}
      />

      <section className="mb-6 rounded-xl border border-border/60 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Trophy className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Competition message</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-muted-foreground">
            Competition
            <select
              value={selectedCompetitionId}
              onChange={(event) => setSelectedCompetitionId(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground"
            >
              <option value="">General announcement</option>
              {competitions.map((competition) => (
                <option key={competition.id} value={competition.id}>{competition.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            Campaign phase
            <select
              value={campaignPhase}
              disabled={!selectedCompetitionId}
              onChange={(event) => setCampaignPhase(event.target.value as CampaignPhase)}
              className="mt-1 block w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground disabled:opacity-50"
            >
              {CAMPAIGN_PHASES.map((phase) => <option key={phase} value={phase}>{phase.replaceAll("_", " ")}</option>)}
            </select>
          </label>
        </div>
        <button
          type="button"
          disabled={!selectedCompetitionId}
          onClick={() => {
            const competition = competitions.find((item) => item.id === selectedCompetitionId);
            if (!competition) return;
            setMessage(competitionMessage(competition.name, campaignPhase));
            setSendToIndividuals(false);
            setConfirming(false);
          }}
          className="mt-3 rounded-lg border border-border/60 px-3 py-2 text-xs font-semibold text-foreground disabled:opacity-50"
        >
          Load private-community template
        </button>
        <p className="mt-2 text-xs text-muted-foreground">
          Competition templates default to community groups only. Public app users and all linked individual accounts stay excluded.
        </p>
      </section>

      <div className="mb-4 space-y-2 rounded-xl border border-border/60 p-3">
        <p className="text-xs font-medium text-muted-foreground">Send to</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={sendToIndividuals}
            onChange={(e) => {
              setSendToIndividuals(e.target.checked);
              setConfirming(false);
            }}
          />
          Everyone linked on Telegram (individual DMs)
        </label>
        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No community groups registered yet. In your group chat, an admin can run <code>/register</code> from
            their linked Telegram to add it here.
          </p>
        ) : (
          groups.map((g) => (
            <label key={g.chat_id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedGroups.has(g.chat_id as number)}
                onChange={(e) => {
                  setSelectedGroups((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(g.chat_id as number);
                    else next.delete(g.chat_id as number);
                    return next;
                  });
                  setConfirming(false);
                }}
              />
              {(g.title as string) || `Group ${g.chat_id}`}
            </label>
          ))
        )}
      </div>

      {imageUrl && (
        <div className="relative mb-3 inline-block">
          <img src={imageUrl} alt="Broadcast attachment" className="max-h-56 rounded-xl border border-border/60" />
          <button
            type="button"
            aria-label="Remove image"
            onClick={() => {
              setImageUrl(null);
              setConfirming(false);
            }}
            className="absolute right-2 top-2 rounded-full bg-black/70 p-1 text-white hover:bg-black"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <textarea
        value={message}
        onChange={(e) => {
          setMessage(e.target.value.slice(0, maxLen));
          setConfirming(false);
        }}
        rows={6}
        maxLength={maxLen}
        placeholder={imageUrl ? "Caption…" : "Announcement text…"}
        className="w-full rounded-xl border border-border/60 bg-background/60 p-3 text-sm text-foreground"
      />
      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
        <div>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-foreground hover:bg-white/[0.04] disabled:opacity-50"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            {uploading ? "Uploading…" : imageUrl ? "Replace image" : "Add image"}
          </button>
        </div>
        <span>
          {message.length} / {maxLen}
        </span>
      </div>
      {uploadError && <p className="mt-2 text-sm text-red-400">{uploadError}</p>}
      {noAudience && <p className="mt-2 text-sm text-amber-400">Pick at least one audience above.</p>}

      {errMsg && (
        <p className="mt-2 text-sm text-red-400">
          {forbidden ? "Admin access required." : errMsg}
        </p>
      )}

      {mutate.data && (
        <p className="mt-2 text-sm text-emerald-400">
          Sent to {mutate.data.sent} / {mutate.data.total}
          {mutate.data.failed > 0 ? ` (${mutate.data.failed} failed)` : ""}.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        {!confirming ? (
          <button
            type="button"
            disabled={message.trim().length === 0 || uploading || noAudience}
            onClick={() => setConfirming(true)}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            Review &amp; send
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={mutate.isPending || noAudience}
              onClick={() => mutate.mutate()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {mutate.isPending
                ? "Sending…"
                : `Confirm — send to ${[sendToIndividuals ? "everyone" : null, selectedGroups.size ? `${selectedGroups.size} group${selectedGroups.size === 1 ? "" : "s"}` : null].filter(Boolean).join(" + ")}`}
            </button>
            <button
              type="button"
              disabled={mutate.isPending}
              onClick={() => setConfirming(false)}
              className="rounded-lg border border-border/60 px-4 py-2 text-sm text-muted-foreground"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const CAMPAIGN_PHASES = ["launch", "reminder", "last_call", "started", "weekly_update", "final_results"] as const;
type CampaignPhase = (typeof CAMPAIGN_PHASES)[number];

function competitionMessage(name: string, phase: CampaignPhase): string {
  const messages: Record<CampaignPhase, string> = {
    launch: `<b>${name}</b>\n\nA private 6-week TurtleBot paper-trading competition for enrolled community members. Every competitor starts with $2,000 in simulated funds. No entry fee, deposits, or real-money trading.\n\nPrizes: 1st $300 · 2nd $150 · 3rd $50\n\n200 seats maximum. Open TurtleBot Community to read the rules and enroll. Apple and Google are not sponsors.`,
    reminder: `<b>${name} — enrollment reminder</b>\n\nThis is a private community paper-trading competition. Open TurtleBot Community to review the official rules and claim an available seat.`,
    last_call: `<b>${name} — last call</b>\n\nEnrollment closes soon. Confirm your leaderboard name and accept rules version 1.0 inside TurtleBot Community.`,
    started: `<b>${name} has started</b>\n\nOnly paper trades closed during the official 6-week window count. Track the private leaderboard in TurtleBot Community.`,
    weekly_update: `<b>${name} — weekly update</b>\n\nThe private leaderboard has been refreshed from verified paper-trade records. Open TurtleBot Community for standings.`,
    final_results: `<b>${name} — results under review</b>\n\nTrading has closed. Final standings remain provisional until the integrity audit is complete. Winners will be contacted privately.`,
  };
  return messages[phase];
}

type CommunityOption = { id: string; name: string; status: string };
type CompetitionOption = { id: string; name: string; status: string; starts_at: string; ends_at: string; entry_count?: number; max_participants: number };

function CompetitionSetup({
  communities,
  competitions,
  createCompetition,
  onCreated,
}: {
  communities: CommunityOption[];
  competitions: CompetitionOption[];
  createCompetition: (options: {
    data: {
      communityId: string;
      name: string;
      startsAt: string;
      enrollmentEndsAt: string;
      rulesUrl: string | null;
    };
  }) => Promise<{ id: string }>;
  onCreated: (id: string) => void;
}) {
  const approved = communities.filter((community) => community.status === "approved");
  const defaultStart = new Date(Date.now() + 7 * 86_400_000);
  defaultStart.setHours(12, 0, 0, 0);
  const [communityId, setCommunityId] = useState("");
  const [name, setName] = useState("TurtleBot Paper League");
  const [startsAt, setStartsAt] = useState(defaultStart.toISOString().slice(0, 16));
  const create = useMutation({
    mutationFn: () => {
      const start = new Date(startsAt);
      return createCompetition({ data: {
        communityId,
        name,
        startsAt: start.toISOString(),
        enrollmentEndsAt: start.toISOString(),
        rulesUrl: null,
      } });
    },
    onSuccess: (competition) => onCreated(competition.id),
  });

  return (
    <section className="mb-6 rounded-xl border border-primary/30 bg-primary/[0.03] p-4 shadow-[8px_8px_18px_rgba(0,0,0,0.34),-4px_-4px_12px_rgba(255,255,255,0.025)]">
      <h2 className="text-sm font-semibold">Private 6-week paper competition</h2>
      <p className="mt-1 text-xs text-muted-foreground">200 community seats · $2,000 simulated balance · $500 total prizes ($300 / $150 / $50).</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-muted-foreground">Community
          <select value={communityId} onChange={(event) => setCommunityId(event.target.value)} className="mt-1 block w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground">
            <option value="">Choose approved community</option>
            {approved.map((community) => <option key={community.id} value={community.id}>{community.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">Competition name
          <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 block w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground" />
        </label>
        <label className="text-xs text-muted-foreground">Starts
          <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} className="mt-1 block w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground" />
        </label>
        <div className="self-end text-xs text-muted-foreground">Enrollment closes at start. Competition ends automatically 42 days later.</div>
      </div>
      <button type="button" disabled={!communityId || name.trim().length < 3 || create.isPending} onClick={() => create.mutate()} className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
        {create.isPending ? "Creating…" : "Create & open enrollment"}
      </button>
      {create.error ? <p className="mt-2 text-xs text-red-400">{create.error instanceof Error ? create.error.message : "Could not create competition."}</p> : null}
      {competitions.length > 0 ? (
        <div className="mt-4 space-y-2 border-t border-border/40 pt-3">
          {competitions.slice(0, 4).map((competition) => (
            <div key={competition.id} className="flex items-center justify-between gap-3 text-xs">
              <span><b className="text-foreground">{competition.name}</b> · {competition.status}</span>
              <span className="text-muted-foreground">{competition.entry_count ?? 0}/{competition.max_participants}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
