import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, Plus, Trash2, Eye, EyeOff, ChevronLeft, ShieldCheck, Check, RefreshCw, X, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { venueLogo } from "@/lib/venue-logos";
import { toast } from "sonner";
import { useIsOwner } from "@/hooks/useIsOwner";
import { SynFuturesSdkPanel } from "@/components/exchanges/trust/SynFuturesSdkPanel";

// Only allowlisted venues are shown. Keep in sync with src/lib/supported-exchanges.ts.
const EXCHANGES = [
  { id: "coinbase", label: "Coinbase", mono: "CB", accent: "#1652F0", kind: "cex" as const, requiresPassphrase: false, available: false },
  { id: "kraken", label: "Kraken", mono: "KR", accent: "#7132F5", kind: "cex" as const, requiresPassphrase: false, available: true },
  { id: "apex_omni", label: "ApeX Omni", mono: "AX", accent: "#14F195", kind: "dex" as const, requiresPassphrase: true, available: true },
  { id: "aster", label: "Aster", mono: "AS", accent: "#F4C15D", kind: "dex" as const, requiresPassphrase: true, available: true },
  { id: "synfutures", label: "SynFutures", mono: "SF", accent: "#2DD4BF", kind: "dex" as const, requiresPassphrase: false, available: true },
] as const;
type ExchangeId = (typeof EXCHANGES)[number]["id"];

type ConnStatus =
  | "not_connected"
  | "verifying"
  | "verified"
  | "needs_attention"
  | "pending_verification"
  | "disabled"
  | "disconnected"
  | "unsupported"
  | "connected"
  | "error";

type Conn = {
  id: string;
  exchange: string;
  status: ConnStatus | null;
  environment: string | null;
  last_verified_at: string | null;
  last_error_message: string | null;
  created_at: string;
};

const STATUS_META: Record<string, { label: string; dot: string; pill: string }> = {
  verified: {
    label: "Verified",
    dot: "bg-positive shadow-[0_0_8px_rgba(115,255,184,0.7)]",
    pill: "bg-positive/10 text-positive border-positive/25",
  },
  verifying: {
    label: "Verifying",
    dot: "bg-primary animate-pulse",
    pill: "bg-primary/10 text-primary border-primary/25",
  },
  pending_verification: {
    label: "Pending verification",
    dot: "bg-amber-400",
    pill: "bg-amber-400/10 text-amber-300 border-amber-400/25",
  },
  needs_attention: {
    label: "Needs attention",
    dot: "bg-negative shadow-[0_0_8px_rgba(255,120,120,0.6)]",
    pill: "bg-negative/10 text-negative border-negative/25",
  },
  disabled: {
    label: "Disabled",
    dot: "bg-muted-foreground/60",
    pill: "bg-white/[0.04] text-muted-foreground border-white/10",
  },
  disconnected: {
    label: "Not connected",
    dot: "bg-muted-foreground/60",
    pill: "bg-white/[0.04] text-muted-foreground border-white/10",
  },
  not_connected: {
    label: "Not connected",
    dot: "bg-muted-foreground/60",
    pill: "bg-white/[0.04] text-muted-foreground border-white/10",
  },
  unsupported: {
    label: "Unsupported",
    dot: "bg-negative",
    pill: "bg-negative/10 text-negative border-negative/25",
  },
  // Legacy fallbacks so pre-Phase-3 rows still render sensibly.
  connected: {
    label: "Pending verification",
    dot: "bg-amber-400",
    pill: "bg-amber-400/10 text-amber-300 border-amber-400/25",
  },
  error: {
    label: "Needs attention",
    dot: "bg-negative",
    pill: "bg-negative/10 text-negative border-negative/25",
  },
};

function exchangeMeta(id: string) {
  return (
    EXCHANGES.find((e) => e.id === id) ?? {
      id,
      label: id,
      mono: id.slice(0, 2).toUpperCase(),
      accent: "#14F195",
      kind: "cex" as const,
      requiresPassphrase: false,
    }
  );
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const s = Math.max(1, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// Credentials are never encoded or stored client-side. The `exchange-credentials`
// edge function encrypts them server-side with AES-256-GCM before persisting.


type Screen =
  | { kind: "list" }
  | { kind: "pick" }
  | { kind: "synfutures" }
  | { kind: "form"; exchange: ExchangeId; replacingId: string | null };

export function ExchangeConnectionsSheet({
  open,
  onOpenChange,
  initialExchange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialExchange?: string;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { isOwner, isReady: ownerReady } = useIsOwner();
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (open) setScreen(initialExchange === "synfutures" ? { kind: "synfutures" } : { kind: "list" });
  }, [open, initialExchange]);

  const { data: rawConns = [], isLoading } = useQuery({
    queryKey: ["exchange-connections", user?.id],
    enabled: !!user && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, status, environment, last_verified_at, last_error_message, created_at")
        .eq("user_id", user!.id)
        .in("exchange", EXCHANGES.map((e) => e.id) as unknown as string[])
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Conn[];
    },
  });

  // Dedupe by exchange — a single exchange should show ONE row. If any row is
  // verified/verifying, prefer it; else fall back to the most recent row.
  // Fixes the visible "verified + not-connected" duplicate for the same venue.
  const conns = useMemo<Conn[]>(() => {
    const isLive = (s: string | null | undefined) =>
      s === "verified" || s === "verifying" || s === "connected";
    const byExchange = new Map<string, Conn>();
    for (const c of rawConns) {
      const existing = byExchange.get(c.exchange);
      if (!existing) {
        byExchange.set(c.exchange, c);
        continue;
      }
      const existingLive = isLive(existing.status);
      const currentLive = isLive(c.status);
      if (currentLive && !existingLive) byExchange.set(c.exchange, c);
    }
    return Array.from(byExchange.values());
  }, [rawConns]);

  function resetState() {
    setScreen({ kind: "list" });
    setConfirmDeleteId(null);
  }

  async function disconnect(id: string) {
    const { data, error } = await supabase.functions.invoke("exchange-credentials", {
      body: { action: "disconnect", connection_id: id },
    });
    if (error || !data?.ok) {
      return toast.error((data as { message?: string } | null)?.message ?? "Could not disconnect.");
    }
    toast.success("Exchange disconnected");
    setConfirmDeleteId(null);
    qc.invalidateQueries({ queryKey: ["exchange-connections", user?.id] });
    qc.invalidateQueries({ queryKey: ["exchange-health", user?.id] });
  }

  async function testConnection(id: string) {
    if (conns.find((row) => row.id === id)?.exchange === "synfutures") {
      setScreen({ kind: "synfutures" });
      return;
    }
    const invalidate = () => {
      qc.invalidateQueries({ queryKey: ["exchange-connections", user?.id] });
      qc.invalidateQueries({ queryKey: ["exchange-health", user?.id] });
    };
    invalidate();
    const { data, error } = await supabase.functions.invoke("exchange-credentials", {
      body: { action: "test", connection_id: id },
    });
    invalidate();
    if (error) {
      return toast.error("Could not run test. Try again.");
    }
    const payload = data as { ok?: boolean; code?: string; message?: string } | null;
    if (payload?.ok) {
      toast.success("Connection verified");
    } else if (payload?.code === "INTEGRATION_PENDING") {
      toast.message("Pending verification", {
        description: payload.message ?? "Live verification unlocks in a later phase.",
      });
    } else {
      toast.error(payload?.message ?? "Verification failed.");
    }
  }




  const connectedIds = conns.map((c) => c.exchange);

  const title =
    screen.kind === "list"
      ? "Exchanges"
      : screen.kind === "pick"
        ? "Choose exchange"
        : screen.kind === "synfutures"
          ? "SynFutures"
          : exchangeMeta(screen.exchange).label;

  const subtitle =
    screen.kind === "list"
      ? `${conns.length} ${conns.length === 1 ? "connection" : "connections"}`
      : screen.kind === "pick"
        ? "Pick the platform you trade on"
        : screen.kind === "synfutures"
          ? "Base wallet setup · trading not active"
          : screen.kind === "form" && screen.replacingId
          ? "Replace API keys"
          : "Connect your API keys";

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) resetState();
      }}
    >
      <SheetContent
        side="bottom"
        className="mx-auto flex h-[88vh] max-w-md flex-col gap-0 rounded-t-[28px] border border-b-0 border-white/10 bg-gradient-to-b from-[#0F1118] to-[#0A0B10] p-0 shadow-[0_-30px_80px_-30px_rgba(0,0,0,0.9)]"
      >
        {/* drag handle */}
        <div className="flex justify-center pt-2.5">
          <span className="h-1.5 w-10 rounded-full bg-white/15" />
        </div>

        {/* app-style nav bar */}
        <div className="relative flex h-14 items-center px-4">
          {screen.kind !== "list" ? (
            <button
              onClick={() =>
                setScreen((screen.kind === "synfutures" || (screen.kind === "form" && !screen.replacingId)) ? { kind: "pick" } : { kind: "list" })
              }
              className="flex h-9 items-center gap-0.5 -ml-2 rounded-full px-2 text-sm text-foreground/85 active:bg-white/[0.06]"
              aria-label="Back"
            >
              <ChevronLeft className="h-5 w-5" />
              <span className="font-medium">Back</span>
            </button>
          ) : (
            <span className="h-9 w-9" />
          )}
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
            <SheetTitle className="text-[15px] font-semibold leading-none">{title}</SheetTitle>
            <SheetDescription className="mt-1 text-[11px] leading-none text-muted-foreground">
              {subtitle}
            </SheetDescription>
          </div>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              resetState();
            }}
            aria-label="Close"
            className="ml-auto flex h-9 w-9 items-center justify-center rounded-full text-foreground/80 transition hover:bg-white/[0.06] active:scale-[0.95]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>


        {/* body */}
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          {screen.kind === "list" && (
            <ListScreen
              conns={conns}
              isLoading={isLoading}
              confirmDeleteId={confirmDeleteId}
              onConfirmDelete={setConfirmDeleteId}
              onDelete={disconnect}
              onTest={testConnection}
              onReplace={(c) =>
                setScreen(c.exchange === "synfutures" ? { kind: "synfutures" } : { kind: "form", exchange: c.exchange as ExchangeId, replacingId: c.id })
              }
              onAdd={() => setScreen({ kind: "pick" })}
            />
          )}

          {screen.kind === "pick" && (
            <PickScreen
              connectedIds={connectedIds}
              onPick={(id) => setScreen(id === "synfutures" ? { kind: "synfutures" } : { kind: "form", exchange: id, replacingId: null })}
            />
          )}

          {screen.kind === "synfutures" && (
            !ownerReady ? <p role="status" className="py-4 text-sm">Checking account access…</p>
              : isOwner ? <SynFuturesSdkPanel />
                : <p role="status" className="py-4 text-sm">SynFutures wallet setup is currently available to the owner account. Live trading is not active.</p>
          )}

          {screen.kind === "form" && (
            <ConnectForm
              exchange={screen.exchange}
              replacingId={screen.replacingId}
              onDone={() => {
                qc.invalidateQueries({ queryKey: ["exchange-connections", user?.id] });
                qc.invalidateQueries({ queryKey: ["exchange-health", user?.id] });
                setScreen({ kind: "list" });
              }}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ---------------- List screen ---------------- */

function ListScreen({
  conns,
  isLoading,
  confirmDeleteId,
  onConfirmDelete,
  onDelete,
  onTest,
  onReplace,
  onAdd,
}: {
  conns: Conn[];
  isLoading: boolean;
  confirmDeleteId: string | null;
  onConfirmDelete: (id: string | null) => void;
  onDelete: (id: string) => void;
  onTest: (id: string) => void;
  onReplace: (c: Conn) => void;
  onAdd: () => void;
}) {
  const [testingId, setTestingId] = useState<string | null>(null);
  return (
    <div className="space-y-2 pt-2">
      {/* security strip */}
      <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-[11px] text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-primary/80" />
        Read-only monitoring by default. Withdrawals always disabled.
      </div>

      {isLoading ? (
        <div className="space-y-2 pt-1">
          {[0, 1].map((i) => (
            <div key={i} className="h-[70px] animate-pulse rounded-2xl bg-white/[0.04]" />
          ))}
        </div>
      ) : conns.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-6 py-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <Plug className="h-6 w-6 text-primary" />
          </div>
          <p className="mt-4 text-sm font-semibold">No exchanges yet</p>
          <p className="mt-1 max-w-[240px] text-xs text-muted-foreground">
            Connect an exchange for controlled test mode. Live execution is off.
          </p>
        </div>
      ) : (
        conns.map((c) => {
          const meta = exchangeMeta(c.exchange);
          const status = STATUS_META[c.status ?? "not_connected"] ?? STATUS_META.not_connected;
          const isConfirming = confirmDeleteId === c.id;
          const isTesting = testingId === c.id || c.status === "verifying";
          const envLabel = (c.environment ?? "test") === "test" ? "Test · Live off" : c.environment ?? "Test · Live off";
          const verifiedLine = c.last_verified_at
            ? `Verified ${timeAgo(c.last_verified_at)}`
            : "Not yet verified";
          return (
            <div
              key={c.id}
              className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]"
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ background: meta.accent, boxShadow: `0 0 14px ${meta.accent}66` }}
              />
              <div className="flex items-center gap-3 p-3 pl-4">
                <ExchangeLogo id={c.exchange} size={44} />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{meta.label}</p>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-medium ${status.pill}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                      {status.label}
                    </span>
                    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-[1px] text-[10px] font-medium text-muted-foreground">
                      {envLabel}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{verifiedLine}</p>
                  {c.last_error_message && (c.status === "needs_attention" || c.status === "unsupported") && (
                    <p className="mt-1 text-[11px] text-negative/90 line-clamp-2">{c.last_error_message}</p>
                  )}
                </div>
              </div>

              {/* row actions */}
              {!isConfirming ? (
                <div className="flex border-t border-white/[0.06]">
                  <button
                    onClick={async () => {
                      if (isTesting) return;
                      setTestingId(c.id);
                      try {
                        await onTest(c.id);
                      } finally {
                        setTestingId(null);
                      }
                    }}
                    disabled={isTesting}
                    className="flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[12px] font-medium text-foreground/85 transition active:bg-white/[0.04] disabled:opacity-60"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isTesting ? "animate-spin" : ""}`} />
                    {isTesting ? "Testing…" : "Test connection"}
                  </button>
                  <span className="w-px bg-white/[0.06]" />
                  <button
                    onClick={() => onReplace(c)}
                    className="flex-1 py-2.5 text-[12px] font-medium text-foreground/85 transition active:bg-white/[0.04]"
                  >
                    Replace keys
                  </button>
                  <span className="w-px bg-white/[0.06]" />
                  <button
                    onClick={() => onConfirmDelete(c.id)}
                    className="flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[12px] font-medium text-negative transition active:bg-negative/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 border-t border-negative/20 bg-negative/[0.06] p-2.5">
                  <p className="flex-1 text-[11px] text-foreground/90">Disconnect {meta.label}?</p>
                  <button
                    onClick={() => onConfirmDelete(null)}
                    className="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted-foreground active:bg-white/[0.06]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => onDelete(c.id)}
                    className="rounded-lg bg-negative px-3 py-1.5 text-[11px] font-semibold text-white active:scale-[0.97]"
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}

      <button
        onClick={onAdd}
        className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-sm font-semibold text-primary-foreground shadow-[0_0_0_1px_rgba(168,85,247,0.25),0_10px_40px_-10px_rgba(168,85,247,0.55)] transition active:scale-[0.97]"
      >
        <Plus className="h-4 w-4" />
        Connect new exchange
      </button>
    </div>
  );
}

/* ---------------- Pick screen (grid, no dropdown) ---------------- */

function PickScreen({
  connectedIds,
  onPick,
}: {
  connectedIds: string[];
  onPick: (id: ExchangeId) => void;
}) {
  return (
    <div className="pt-2">
      <div className="grid grid-cols-2 gap-2.5">
        {EXCHANGES.map((e) => {
          const taken = connectedIds.includes(e.id);
          const disabled = (taken && e.id !== "synfutures") || !e.available;
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => {
                if (!disabled) onPick(e.id);
              }}
              disabled={disabled}
              aria-label={!e.available ? `${e.label} dedicated signer setup required` : undefined}
              className="group relative flex flex-col items-start gap-2 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-3.5 text-left transition enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70"
            >
              <span
                aria-hidden
                className="absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-20 blur-2xl transition group-active:opacity-40"
                style={{ background: e.accent }}
              />
              <div className="flex w-full items-center justify-between">
                <ExchangeLogo id={e.id} size={40} />
                <span
                  className={`inline-flex items-center rounded-full border px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wider ${
                    e.kind === "dex"
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-white/10 bg-white/[0.04] text-muted-foreground"
                  }`}
                >
                  {e.kind === "dex" ? "Perp DEX" : "CEX"}
                </span>
              </div>

              <div className="flex w-full items-center justify-between">
                <span className="text-sm font-semibold">{e.label}</span>
                {taken ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-positive/25 bg-positive/10 px-1.5 py-[1px] text-[9px] font-medium text-positive">
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    On
                  </span>
                ) : !e.available ? (
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Signer setup
                  </span>
                ) : null}
              </div>
              {e.kind === "dex" && (
                <span className="text-[10px] leading-tight text-muted-foreground">
                  {e.id === "apex_omni"
                    ? "Mainnet · live execution after verification"
                    : e.id === "aster"
                      ? "Mainnet · V3 agent signer required"
                      : "Base mainnet · open wallet setup"}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-4 px-1 text-[11px] leading-relaxed text-muted-foreground">
        TurtleBot's perpetual venue set is ApeX Omni, Aster, and SynFutures. Each venue uses its
        own signer and reconciliation path; integrations cannot borrow another venue's credentials.
      </p>
    </div>
  );
}

/* ---------------- Connect / Replace form ---------------- */

function ConnectForm({
  exchange,
  replacingId,
  onDone,
}: {
  exchange: ExchangeId;
  replacingId: string | null;
  onDone: () => void;
}) {
  const { user } = useAuth();
  const meta = exchangeMeta(exchange);
  const requiresPassphrase = meta.requiresPassphrase;
  const isDex = meta.kind === "dex";
  const isAster = exchange === "aster";
  // ApeX Omni MAINNET is the only venue that uses the Omni Key seed for L2
  // order signing. Testnet doesn't need it. Optional at connect time — order
  // signing on the Railway worker will require it later.
  const supportsOmniSeed = exchange === "apex_omni";
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [omniSeed, setOmniSeed] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [withdrawalsDisabled, setWithdrawalsDisabled] = useState(false);

  const isEvmAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value.trim());
  const canSubmit =
    (isAster ? isEvmAddress(apiKey) : apiKey.trim().length > 4) &&
    apiSecret.trim().length > 4 &&
    (!requiresPassphrase || (isAster ? isEvmAddress(passphrase) : passphrase.trim().length > 0)) &&
    withdrawalsDisabled &&
    !submitting;


  async function save() {
    if (!user || !canSubmit) return;
    setSubmitting(true);
    const keyPlain = apiKey.trim();
    const secretPlain = apiSecret.trim();
    const passPlain = passphrase.trim();
    const seedPlain = omniSeed.trim();
    // Wipe local state immediately so plaintext doesn't linger in the DOM.
    setApiKey("");
    setApiSecret("");
    setPassphrase("");
    setOmniSeed("");

    const { data, error } = await supabase.functions.invoke("exchange-credentials", {
      body: {
        action: replacingId ? "replace" : "connect",
        exchange,
        api_key: keyPlain,
        api_secret: secretPlain,
        passphrase: requiresPassphrase ? passPlain : undefined,
        omni_seed: supportsOmniSeed && seedPlain ? seedPlain : undefined,
        connection_id: replacingId ?? undefined,
        withdrawals_disabled_attestation: withdrawalsDisabled,
      },
    });

    if (error || !data?.ok) {
      setSubmitting(false);
      return toast.error(
        (data as { message?: string } | null)?.message ?? "Could not save credentials.",
      );
    }

    const connectionId = (data as { connection_id?: string }).connection_id;
    if (!connectionId) {
      setSubmitting(false);
      return toast.error("Credentials were saved, but the connection identifier was missing. Please try again.");
    }
    const { data: verification, error: verificationError } = await supabase.functions.invoke(
      "exchange-credentials",
      { body: { action: "test", connection_id: connectionId } },
    );
    if (verificationError || !verification?.ok) {
      setSubmitting(false);
      return toast.error(
        (verification as { message?: string } | null)?.message ??
          "Credentials were saved securely, but verification failed.",
      );
    }
    toast.success(replacingId ? "Keys replaced and verified" : `${meta.label} connected and verified`);
    setSubmitting(false);
    onDone();
  }


  return (
    <div className="pt-2">
      {/* brand banner */}
      <div
        className="relative mb-4 overflow-hidden rounded-2xl border border-white/10 p-4"
        style={{
          background: `linear-gradient(135deg, ${meta.accent}1F, ${meta.accent}05 60%, transparent)`,
        }}
      >
        <div className="flex items-center gap-3">
          <ExchangeLogo id={exchange} size={48} radius={16} />

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-base font-semibold">{meta.label}</p>
              <span
                className={`inline-flex items-center rounded-full border px-1.5 py-[1px] text-[10px] font-medium ${
                  isDex
                    ? "border-primary/25 bg-primary/10 text-primary"
                    : "border-white/10 bg-white/[0.04] text-muted-foreground"
                }`}
              >
                {isDex ? "DEX · mainnet" : "CEX"}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {replacingId
                ? "Replace existing keys — pending re-verification"
                : exchange === "kraken"
                  ? "Create a Kraken Spot key with Query Funds only; disable every withdrawal permission"
                : isAster
                  ? "Create a dedicated Pro API agent with Perpetual trading enabled and Withdrawals disabled. Never enter your owner-wallet private key."
                : isDex
                  ? "Generate a read-only API key at omni.apex.exchange/keyManagement. Passphrase is the one set when creating the API key — not your account password."
                  : `Create an API key in your ${meta.label} dashboard (read + trade only)`}
            </p>
          </div>
        </div>
      </div>

      {isAster && (
        <a
          href="https://www.asterdex.com/en/api-wallet"
          target="_blank"
          rel="noreferrer"
          className="mb-3 flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-[#F4C15D]/25 bg-[#F4C15D]/[0.08] text-[12px] font-semibold text-[#F4C15D] transition hover:bg-[#F4C15D]/[0.12]"
        >
          Open Aster Pro API
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}

      <div className="space-y-2.5">
        <SecretField
          label={isAster ? "Master wallet address" : "API Key"}
          value={apiKey}
          onChange={setApiKey}
          show={showKey}
          onToggle={() => setShowKey((v) => !v)}
          placeholder={isAster ? "0x… owner wallet address" : "Paste your API key"}
        />
        <SecretField
          label={isAster ? "Agent signing key" : "API Secret"}
          value={apiSecret}
          onChange={setApiSecret}
          show={showSecret}
          onToggle={() => setShowSecret((v) => !v)}
          placeholder={isAster ? "Paste the dedicated Pro API agent key" : "Paste your API secret"}
        />
        {requiresPassphrase && (
          <SecretField
            label={isAster ? "Agent wallet address" : "Passphrase"}
            value={passphrase}
            onChange={setPassphrase}
            show={showPass}
            onToggle={() => setShowPass((v) => !v)}
            placeholder={isAster ? "0x… Pro API agent address" : "Paste your API passphrase"}
          />
        )}
        {supportsOmniSeed && (
          <SecretField
            label="Omni Key seed (optional)"
            value={omniSeed}
            onChange={setOmniSeed}
            show={showSeed}
            onToggle={() => setShowSeed((v) => !v)}
            placeholder="Paste your Omni Key seed"
          />
        )}
      </div>
      {supportsOmniSeed && (
        <p className="mt-2 px-1 text-[10.5px] leading-snug text-muted-foreground">
          The Omni Key seed is required only for placing L2-signed orders. Read-only balance verification
          works without it. It is encrypted with the same scheme as your API secret and never displayed
          back to you.
        </p>
      )}

      <ul className="mt-3 space-y-1.5 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-[11px] text-muted-foreground">
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
          Enable <span className="font-medium text-foreground/90">{exchange === "kraken" ? "Query Funds" : isAster ? "Perpetual trading" : `read${isDex ? "" : " + trade"}`}</span> only. Do <span className="font-medium text-foreground/90">not</span> enable withdrawal — the bot never needs it.
        </li>
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
          {isAster
            ? "The dedicated agent key is encrypted server-side and never displayed again. Never paste your owner-wallet private key."
            : "Keys are encrypted server-side. We never display saved secrets back to you."}
        </li>
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
          {isAster
            ? "Aster is verified against its V3 API before it can be armed for live execution."
            : isDex
            ? "Read-only mainnet monitoring. Live execution is unavailable pending jurisdiction and licensing approval."
            : "Connect for controlled test mode. Live execution stays off until verified."}
        </li>
      </ul>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 text-[12px] leading-snug text-foreground/90 transition hover:bg-white/[0.05]">
        <input
          type="checkbox"
          checked={withdrawalsDisabled}
          onChange={(e) => setWithdrawalsDisabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
        />
        <span>
          I confirm this API key has <span className="font-semibold">withdrawals disabled</span>.
          Turtle Bot is non-custodial and never needs withdrawal permission.
        </span>
      </label>

      <button

        onClick={save}
        disabled={!canSubmit}
        className="mt-5 flex h-12 w-full items-center justify-center rounded-2xl bg-primary text-sm font-semibold text-primary-foreground shadow-[0_0_0_1px_rgba(168,85,247,0.25),0_10px_40px_-10px_rgba(168,85,247,0.55)] transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Saving…" : replacingId ? "Replace keys" : `Connect ${meta.label}`}
      </button>
    </div>
  );
}

function SecretField({
  label,
  value,
  onChange,
  show,
  onToggle,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
  placeholder: string;
}) {
  return (
    <div className="rounded-[18px] border border-white/10 bg-white/[0.05] px-4 py-2.5 transition focus-within:border-primary/30 focus-within:bg-white/[0.06]">
      <label className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 bg-transparent text-sm font-medium text-foreground tabular-nums placeholder:text-muted-foreground/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={onToggle}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
          aria-label={show ? "Hide" : "Show"}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function ExchangeLogo({ id, size = 40, radius = 12 }: { id: string; size?: number; radius?: number }) {
  const meta = exchangeMeta(id);
  const src = venueLogo(id);
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    border: `1px solid ${meta.accent}33`,
    background: src
      ? "#0B0D12"
      : `linear-gradient(135deg, ${meta.accent}33, ${meta.accent}0D)`,
    color: meta.accent,
  };
  if (src) {
    return (
      <img
        src={src}
        alt={`${meta.label} logo`}
        loading="lazy"
        width={size}
        height={size}
        className="shrink-0 object-contain p-1"
        style={style}
      />
    );
  }
  return (
    <div
      style={style}
      className="flex shrink-0 items-center justify-center text-[11px] font-bold tracking-wider"
    >
      {meta.mono}
    </div>
  );
}
