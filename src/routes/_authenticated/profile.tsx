// Operator profile — the ONE settings home.
// Sections (in order): account details, trading mode, exchange connections
// (summary + link to /exchanges), notifications, security & 2FA, plan &
// billing, appearance, sign out.
//
// Phantom shell only: CinematicHero + SurfaceCard, tokens --accent /
// --positive / --negative. No AtmosphereShell, no CommandPanel, no
// BackButton (this is a top-level destination reached via the avatar).

import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LogOut,
  Beaker,
  ChevronRight,
  Plug,
  Camera,
  Loader2,
  ShieldCheck,
  BellRing,
  Sparkles,
  BadgeCheck,
  Save,
  Palette,
  Send,
  ShieldAlert,
  BrainCircuit,
  Gauge,
  FileText,
  Trash2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useIsOwner } from "@/hooks/useIsOwner";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { CHARACTERS, type CharacterKey } from "@/lib/character-assets";
import { CinematicHero } from "@/components/shell/CinematicHero";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const AI_CONSENT_VERSION = "2026-09-07";

const DEFAULT_FAVORITE: CharacterKey = "phantom";

export const Route = createFileRoute("/_authenticated/profile")({
  component: ProfilePage,
  head: () => ({
    meta: [
      { title: "Profile & Settings — TurtleBot" },
      {
        name: "description",
        content: "Manage your TurtleBot identity, trading mode, notifications, security, and plan.",
      },
    ],
  }),
});

function ProfilePage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { isOwner } = useIsOwner();

  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: connections = [] } = useQuery({
    queryKey: ["exchange_connections", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, status")
        .eq("user_id", user!.id);
      if (error) throw error;
      return data ?? [];
    },
  });
  const activeConnCount = connections.filter(
    (c) => c.status !== "disconnected" && c.status !== "disabled",
  ).length;

  // Avatar upload
  const inputRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!user || !profile?.avatar_url) {
      setAvatarUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data: signed } = await supabase.storage
        .from("avatars")
        .createSignedUrl(profile.avatar_url!, 60 * 60);
      if (!cancelled) setAvatarUrl(signed?.signedUrl ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, profile?.avatar_url]);

  async function onPickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user) return;
    if (file.size > 5 * 1024 * 1024) return toast.error("Image must be under 5MB");
    setUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${user.id}/avatar.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { error: dbErr } = await supabase
        .from("profiles")
        .update({ avatar_url: path })
        .eq("id", user.id);
      if (dbErr) throw dbErr;
      qc.invalidateQueries({ queryKey: ["profile", user.id] });
      toast.success("Photo updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function setDemo(next: boolean) {
    if (!user) return;
    const { error } = await supabase.from("profiles").update({ demo_mode: next }).eq("id", user.id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["profile", user.id] });
  }

  // profiles.account_mode is DEPRECATED as a global "trading mode" toggle.
  // Kept only as the DEFAULT market pre-selected when creating a new
  // connection. Market type is now per-connection (exchange_connections.market_type).
  // TODO: remove column once no read paths remain.

  async function signOut() {
    navigate({ to: "/logout" });
  }

  const demoMode = profile?.demo_mode ?? true;
  const savedName = profile?.display_name ?? "";
  const savedPhone = (profile as { phone?: string | null } | null)?.phone ?? "";
  const savedFavorite =
    ((profile as { favorite_character?: string | null } | null)?.favorite_character as
      CharacterKey | undefined) ?? DEFAULT_FAVORITE;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [favorite, setFavorite] = useState<CharacterKey>(DEFAULT_FAVORITE);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [savingAiConsent, setSavingAiConsent] = useState(false);

  useEffect(() => {
    setName(savedName);
    setPhone(savedPhone);
    setFavorite(
      (savedFavorite && CHARACTERS[savedFavorite]
        ? savedFavorite
        : DEFAULT_FAVORITE) as CharacterKey,
    );
  }, [savedName, savedPhone, savedFavorite]);
  useEffect(() => {
    setEmail(user?.email ?? "");
  }, [user?.email]);

  const displayName = savedName || "Trader";
  const initials = displayName
    .split(" ")
    .map((s: string) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const favoriteChar = CHARACTERS[favorite] ?? CHARACTERS[DEFAULT_FAVORITE];
  const heroImage = favoriteChar.url;

  const dirty = useMemo(
    () =>
      name.trim() !== savedName ||
      email.trim() !== (user?.email ?? "") ||
      phone.trim() !== savedPhone ||
      favorite !== savedFavorite,
    [name, email, phone, favorite, savedName, savedPhone, savedFavorite, user?.email],
  );

  const emailValid = /^\S+@\S+\.\S+$/.test(email.trim());
  const phoneValid = phone.trim() === "" || /^[+\d][\d\s().-]{5,20}$/.test(phone.trim());
  const canSave = dirty && name.trim().length > 0 && emailValid && phoneValid && !saving;

  async function saveProfile() {
    if (!user || !canSave) return;
    setSaving(true);
    try {
      const patch = {
        display_name: name.trim(),
        phone: phone.trim() || null,
        favorite_character: favorite,
      };
      const { error: dbErr } = await supabase
        .from("profiles")
        .update(patch as never)
        .eq("id", user.id);
      if (dbErr) throw dbErr;

      if (email.trim() !== (user.email ?? "")) {
        const { error: authErr } = await supabase.auth.updateUser({
          email: email.trim(),
        });
        if (authErr) throw authErr;
        toast.success("Saved. Check your inbox to confirm the new email.");
      } else {
        toast.success("Profile updated");
      }
      qc.invalidateQueries({ queryKey: ["profile", user.id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function setAiConsent(enabled: boolean) {
    if (!user || savingAiConsent) return;
    setSavingAiConsent(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        ai_data_consent_at: enabled ? new Date().toISOString() : null,
        ai_data_consent_version: enabled ? AI_CONSENT_VERSION : null,
      })
      .eq("id", user.id);
    setSavingAiConsent(false);
    if (error) return toast.error(`Could not update AI privacy permission: ${error.message}`);
    await qc.invalidateQueries({ queryKey: ["profile", user.id] });
    toast.success(
      enabled
        ? "AI data sharing enabled. You can withdraw this permission here at any time."
        : "AI data sharing disabled. Guided, on-device-safe explanations remain available.",
    );
  }

  async function deleteAccount() {
    if (deleteConfirmation !== "DELETE" || deleting) return;
    setDeleting(true);
    const { data, error } = await supabase.functions.invoke("delete-account", {
      body: { confirmation: deleteConfirmation },
    });
    if (error || !data?.ok) {
      setDeleting(false);
      toast.error(data?.message ?? "Account deletion failed. Nothing was reported as deleted.");
      return;
    }
    await supabase.auth.signOut({ scope: "local" });
    window.location.assign("/welcome");
  }

  const nftReady = Boolean(name.trim() && emailValid && phone.trim() && phoneValid);

  /* ============ shared section builders ============ */

  const IdentityBlock = (
    <SurfaceCard>
      <div className="flex items-center gap-4">
        <button
          onClick={() => inputRef.current?.click()}
          className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl bg-white/[0.06] active:scale-[0.97]"
          aria-label="Change profile photo"
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center"
              style={{
                background: "linear-gradient(135deg, rgba(153,69,255,0.35), rgba(153,69,255,0.05))",
              }}
            >
              <span className="text-xl font-semibold text-white">{initials || "T"}</span>
            </div>
          )}
          <span className="absolute inset-x-0 bottom-0 flex h-5 items-center justify-center gap-1 bg-black/60 text-[9px] font-medium uppercase tracking-wider text-white opacity-0 transition group-hover:opacity-100">
            {uploading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Camera className="h-3 w-3" />
            )}
            Edit
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickAvatar}
        />

        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
            Callsign
          </p>
          <p className="mt-0.5 truncate text-[20px] font-semibold leading-tight text-white">
            {displayName}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Pill tone={demoMode ? "muted" : "positive"}>{demoMode ? "Demo" : "Live"}</Pill>
            <Pill tone="muted">Mainnet locked</Pill>
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            placeholder="Your name"
            className="w-full bg-transparent text-[13.5px] text-white placeholder:text-white/40 focus:outline-none"
          />
        </Field>
        <Field label="Email" hint={emailValid ? undefined : "Enter a valid email"}>
          <input
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value.slice(0, 120))}
            placeholder="you@domain.com"
            className="w-full bg-transparent text-[13.5px] text-white placeholder:text-white/40 focus:outline-none"
          />
        </Field>
        <Field label="Phone" hint={phoneValid ? undefined : "Digits, spaces, + ( ) only"}>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value.slice(0, 22))}
            placeholder="+1 555 123 4567"
            className="w-full bg-transparent text-[13.5px] text-white placeholder:text-white/40 focus:outline-none"
          />
        </Field>
        <Field label="Favorite character">
          <select
            value={favorite}
            onChange={(e) => setFavorite(e.target.value as CharacterKey)}
            className="w-full appearance-none bg-transparent text-[13.5px] text-white focus:outline-none"
          >
            {Object.values(CHARACTERS).map((c) => (
              <option key={c.key} value={c.key} className="bg-black text-white">
                {c.name} — {c.tagline}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <button
        onClick={saveProfile}
        disabled={!canSave}
        className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: "var(--accent)" }}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
      </button>

      <div
        className={`mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[11.5px] ${
          nftReady ? "bg-emerald-500/10 text-emerald-200" : "bg-amber-500/10 text-amber-200/90"
        }`}
      >
        <BadgeCheck className="h-4 w-4 shrink-0" />
        <span>
          {nftReady
            ? "Profile complete — you qualify for TurtleBot NFT drops."
            : "Complete name, email, and phone to qualify for TurtleBot NFT drops."}
        </span>
      </div>
    </SurfaceCard>
  );

  const SettingsSections = (
    <div className="space-y-6">
      {/* Demo mode. Market type is now per-connection — set on the
          Exchanges page when adding a connection. */}
      <Section title="Session">
        <SurfaceCard className="p-2">
          <ToggleRow
            icon={Beaker}
            label="Demo mode"
            hint={demoMode ? "Simulated trades — no real funds" : "Live trading enabled"}
            checked={demoMode}
            onChange={setDemo}
          />
        </SurfaceCard>
      </Section>

      {/* Exchange connections — link to canonical /exchanges */}
      <Section title="Exchange connections">
        <SurfaceCard className="p-1">
          <LinkRow
            to="/exchanges"
            icon={Plug}
            label="Manage exchanges"
            value={
              activeConnCount === 0
                ? "None connected — set one up on Exchanges"
                : `${activeConnCount} of 6 active · configured on Exchanges`
            }
          />
        </SurfaceCard>
      </Section>

      {/* Notifications */}
      <Section title="Notifications">
        <SurfaceCard className="p-1">
          <LinkRow
            to="/notifications"
            icon={BellRing}
            label="Push, email & alerts"
            value="Configure delivery and channels"
          />
        </SurfaceCard>
      </Section>

      {/* Telegram */}
      <Section title="Telegram">
        <SurfaceCard className="p-1">
          <LinkRow
            to="/telegram"
            icon={Send}
            label="Ask the council from Telegram"
            value="Link your account and query any ticker"
          />
        </SurfaceCard>
      </Section>

      {/* Onixus admin — only rendered for owner/admin accounts; server-side checks are still authoritative. */}
      {isOwner ? (
        <Section title="Onixus admin">
          <SurfaceCard className="p-1 divide-y divide-white/[0.04]">
            <LinkRow
              to="/admin/communities"
              icon={ShieldAlert}
              label="Control Center"
              value="Community applications, seats and plans"
            />
            <LinkRow
              to="/admin/broadcast"
              icon={Send}
              label="Campaign Manager"
              value="Run private community competition campaigns"
            />
            <LinkRow
              to="/admin/ai-usage"
              icon={Gauge}
              label="AI Usage & Cost"
              value="Tokens, estimated spend and provider health"
            />
          </SurfaceCard>
        </Section>
      ) : null}

      {/* Security & 2FA */}
      <Section title="Security & 2FA">
        <SurfaceCard className="p-1">
          <LinkRow
            to="/welcome/pin"
            icon={ShieldCheck}
            label="PIN & Face ID"
            value="Change your app PIN and biometrics"
          />
        </SurfaceCard>
      </Section>

      <Section title="AI & privacy">
        <SurfaceCard className="p-1">
          <ToggleRow
            icon={BrainCircuit}
            label="Share context with selected AI providers"
            hint="Required only for AI-generated Onyx and Council answers"
            checked={Boolean(profile?.ai_data_consent_at)}
            disabled={savingAiConsent}
            onChange={(enabled) => void setAiConsent(enabled)}
          />
          <div className="divide-y divide-white/[0.04] border-t border-white/[0.04]">
            <LinkRow
              to="/privacy"
              icon={FileText}
              label="Privacy policy"
              value="What is collected, shared, retained, and deleted"
            />
            <LinkRow
              to="/data-deletion"
              icon={Trash2}
              label="Data deletion information"
              value="Review deletion scope and timing"
            />
          </div>
        </SurfaceCard>
        <p className="mt-2 px-1 text-[10.5px] leading-4 text-white/40">
          When enabled, only relevant setup and trading context is sent to the AI providers you
          select. Exchange secrets, wallet keys, PINs, and withdrawal credentials are never sent.
        </p>
      </Section>

      {/* Plan & billing */}
      <Section title="Plan & billing">
        <SurfaceCard className="p-1">
          <LinkRow
            to="/plan"
            icon={Sparkles}
            label="Subscription"
            value="Manage tier, seats, and invoices"
          />
        </SurfaceCard>
      </Section>

      {/* Appearance */}
      <Section title="Appearance">
        <SurfaceCard>
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
              style={{ background: "rgba(153,69,255,0.15)", color: "var(--accent)" }}
            >
              <Palette className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-semibold text-white">Dark mode</p>
              <p className="text-[11.5px] text-white/50">TurtleBot is dark-only by design.</p>
            </div>
          </div>
        </SurfaceCard>
      </Section>

      <button
        onClick={signOut}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[color:var(--negative)]/10 text-sm font-medium text-[color:var(--negative)] transition hover:bg-[color:var(--negative)]/15 active:scale-[0.99]"
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </button>

      <button
        type="button"
        onClick={() => setDeleteOpen(true)}
        className="tb-neu-inset flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-sm font-medium text-red-300 transition active:scale-[0.99]"
      >
        <Trash2 className="h-4 w-4" />
        Delete account
      </button>

      <p className="text-center text-[10.5px] uppercase tracking-[0.18em] text-white/40">
        TurtleBot · v1.0
      </p>
    </div>
  );

  return (
    <div className="min-h-[100dvh] bg-black text-white">
      {/* MOBILE + TABLET */}
      <div className="xl:hidden">
        <CinematicHero
          image={heroImage}
          imagePosition="right 20%"
          className="h-[220px] md:h-[280px]"
          eyebrow="Operator profile"
          title={displayName}
          subtitle={user?.email ?? undefined}
        />
        <div className="mx-auto max-w-[720px] space-y-5 px-4 pb-4 pt-4 md:max-w-[900px] md:px-6">
          {IdentityBlock}
          {SettingsSections}
        </div>
      </div>

      {/* DESKTOP (>=1280) — two-column: identity left, sections right */}
      <div className="hidden xl:block">
        <div className="px-8 py-8">
          <div className="mb-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
              Operator profile
            </p>
            <h1 className="text-[28px] font-bold text-white" style={{ letterSpacing: "-0.02em" }}>
              Profile &amp; settings
            </h1>
          </div>
          <div className="grid grid-cols-12 gap-6">
            <div className="col-span-5">{IdentityBlock}</div>
            <div className="col-span-7">{SettingsSections}</div>
          </div>
        </div>
      </div>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (deleting) return;
          setDeleteOpen(open);
          if (!open) setDeleteConfirmation("");
        }}
      >
        <DialogContent className="tb-neu-panel w-[calc(100%-2rem)] max-w-md rounded-[28px] border-white/10 bg-[#0b0c12] text-white">
          <DialogHeader>
            <DialogTitle>Delete your TurtleBot account?</DialogTitle>
            <DialogDescription className="text-white/55">
              This permanently deletes your account, profile, AI keys, exchange credentials,
              settings, and trading records except records we must retain by law. This cannot be
              undone and does not close an account held at an exchange.
            </DialogDescription>
          </DialogHeader>
          <label className="text-xs text-white/65">
            Type <strong className="text-white">DELETE</strong> to confirm
            <input
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
              className="tb-neu-inset mt-2 h-12 w-full rounded-2xl bg-transparent px-4 text-sm text-white outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => void deleteAccount()}
            disabled={deleteConfirmation !== "DELETE" || deleting}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-red-500/15 text-sm font-semibold text-red-200 disabled:opacity-35"
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {deleting ? "Deleting account…" : "Permanently delete account"}
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ============ primitives ============ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-white/45">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "accent" | "positive" | "muted";
}) {
  const styles: Record<string, string> = {
    accent: "bg-[color:var(--accent)]/15 text-[color:var(--accent)]",
    positive: "bg-[color:var(--positive)]/15 text-[color:var(--positive)]",
    muted: "bg-white/[0.06] text-white/60",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${styles[tone]}`}>
      {children}
    </span>
  );
}

function IconTile({ icon: Icon }: { icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
      style={{ background: "rgba(153,69,255,0.15)", color: "var(--accent)" }}
    >
      <Icon className="h-5 w-5" />
    </div>
  );
}

function RowInner({
  icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <>
      <IconTile icon={icon} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-semibold text-white">{label}</p>
        <p className="truncate text-[11.5px] text-white/55">{value}</p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-white/45" />
    </>
  );
}

function LinkRow(props: {
  to:
    | "/exchanges"
    | "/notifications"
    | "/plan"
    | "/welcome/pin"
    | "/telegram"
    | "/admin/communities"
    | "/admin/broadcast"
    | "/admin/ai-usage"
    | "/privacy"
    | "/data-deletion";
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  const { to, ...rest } = props;
  return (
    <Link
      to={to}
      className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition hover:bg-white/[0.04]"
    >
      <RowInner {...rest} />
    </Link>
  );
}

function ToggleRow({
  icon,
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl px-3 py-3">
      <IconTile icon={icon} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-semibold text-white">{label}</p>
        <p className="truncate text-[11.5px] text-white/55">{hint}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}


function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block rounded-xl bg-white/[0.04] px-3 py-2 focus-within:ring-1 focus-within:ring-[color:var(--accent)]/40">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">
        {label}
      </span>
      <div className="mt-0.5">{children}</div>
      {hint ? <span className="mt-1 block text-[10.5px] text-amber-300/90">{hint}</span> : null}
    </label>
  );
}
