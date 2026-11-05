// Proof-of-life trade trigger — owner-gated one-shot button that inserts a
// `worker_commands` row (unique partial index enforces one pending per owner).
// The Railway worker atomically claims the row on its next cycle, emits ONE
// minimum-size intent through the broker/signer pipeline, and reports the
// sanitized outcome back to the row for polling here.
//
// Honest states: pending → claimed → completed / failed. No lying spinners.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Radio, ShieldAlert } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { cn } from "@/lib/utils";

interface WorkerCommandRow {
  id: string;
  status: "pending" | "consumed" | "completed" | "failed";
  symbol: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  result: Record<string, unknown> | null;
  error_message: string | null;
}

function friendlyError(msg: string | null | undefined): string | null {
  if (!msg) return null;
  if (msg === "INVALID_HMAC_SIGNATURE" || msg === "UNAUTHORIZED") {
    return "SHARED SECRET MISMATCH — re-paste the edge secret";
  }
  if (msg === "SIGNER_NOT_CONFIGURED") {
    return "Edge secret SIGNER_SHARED_SECRET missing";
  }
  return msg;
}

export function ProofOfLifeButton({
  connectionId,
  environment,
  isLive,
  permissionTrade,
  permissionsVerified,
  connectionStatus,
}: {
  connectionId: string;
  environment: string;
  isLive: boolean;
  permissionTrade: boolean;
  permissionsVerified: boolean;
  connectionStatus: string;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [inflight, setInflight] = useState(false);

  // Only render for admins on mainnet, live-enabled connections.
  const roleQ = useQuery({
    queryKey: ["role", "admin", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("has_role", {
        _user_id: user!.id,
        _role: "admin",
      });
      if (error) throw error;
      return Boolean(data);
    },
  });

  // REST-credential key parity check. Compares the Edge Function's
  // TURTLE_CREDENTIAL_ENCRYPTION_KEY fingerprint against the Railway
  // signer's, using the connection's stored ciphertext to detect actual
  // decrypt capability. A mismatch is the #1 cause of DECRYPT_FAILED on
  // /v1/orders.
  const parityQ = useQuery<{
    edge_key_fingerprint: string;
    signer_key_fingerprint: string | null;
    signer_status: string | null;
    signer_error: string | null;
    match: boolean;
  } | null>({
    queryKey: ["exchange-credentials", "key_parity", connectionId, user?.id],
    enabled: !!user?.id && !!roleQ.data && !!connectionId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("exchange-credentials", {
        body: { action: "key_parity", connection_id: connectionId },
      });
      if (error) throw error;
      return data as never;
    },
  });

  const latestQ = useQuery<WorkerCommandRow | null>({
    queryKey: ["worker_commands", "latest", user?.id],
    enabled: !!user?.id && !!roleQ.data,
    refetchInterval: (data) => {
      const row = data as unknown as WorkerCommandRow | null;
      if (!row) return 5000;
      return row.status === "pending" || row.status === "consumed" ? 3000 : 8000;
    },
    queryFn: async () => {
      const { data, error } = await supabase
        .from("worker_commands")
        .select(
          "id, status, symbol, claimed_at, completed_at, created_at, result, error_message",
        )
        .eq("user_id", user!.id)
        .eq("command", "test_order")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as WorkerCommandRow | null) ?? null;
    },
  });

  const latestStratQ = useQuery<WorkerCommandRow | null>({
    queryKey: ["worker_commands", "latest_strategy", user?.id],
    enabled: !!user?.id && !!roleQ.data,
    refetchInterval: (data) => {
      const row = data as unknown as WorkerCommandRow | null;
      if (!row) return 5000;
      return row.status === "pending" || row.status === "consumed" ? 3000 : 8000;
    },
    queryFn: async () => {
      const { data, error } = await supabase
        .from("worker_commands")
        .select(
          "id, status, symbol, claimed_at, completed_at, created_at, result, error_message",
        )
        .eq("user_id", user!.id)
        .eq("command", "strategy_test")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as WorkerCommandRow | null) ?? null;
    },
  });


  const fire = useMutation({
    mutationFn: async () => {
      setInflight(true);
      const { data, error } = await supabase
        .from("worker_commands")
        .insert({
          user_id: user!.id,
          command: "test_order",
          symbol: "BTC-USDT",
          params: { connection_id: connectionId },
        })
        .select("id")
        .single();
      if (error) throw error;
      return data;
    },
    onSettled: () => {
      setInflight(false);
      qc.invalidateQueries({ queryKey: ["worker_commands", "latest"] });
    },
  });

  const fireStrategy = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("worker_commands")
        .insert({
          user_id: user!.id,
          command: "strategy_test",
          symbol: "BTC-USDT",
          params: { connection_id: connectionId, side: "BUY" },
        })
        .select("id")
        .single();
      if (error) throw error;
      return data;
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["worker_commands", "latest_strategy"] });
    },
  });

  // Auto-register the ApeX account for this wallet. Idempotent on ApeX's
  // side — safe to re-run if the first attempt half-succeeded.
  const register = useMutation<
    { ok: boolean; code?: string; account_id?: string | null },
    Error,
    void
  >({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("exchange-credentials", {
        body: { action: "register_account", connection_id: connectionId },
      });
      if (error) throw new Error(error.message ?? "REGISTER_FAILED");
      const payload = data as { ok?: boolean; code?: string; message?: string; account_id?: string | null };
      if (!payload?.ok) {
        throw new Error(payload?.code ?? payload?.message ?? "REGISTER_FAILED");
      }
      return payload as { ok: boolean; code?: string; account_id?: string | null };
    },
    onSuccess: async () => {
      // Registration promotes the persisted connection to verified + trade
      // enabled. Refresh every consumer of that row immediately so the Trust
      // Center cannot keep showing the pre-registration BLOCKED state until a
      // full page reload.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["worker_commands", "latest"] }),
        qc.invalidateQueries({ queryKey: ["exchange-credentials"] }),
        qc.invalidateQueries({ queryKey: ["exchange-connections-full"] }),
        qc.invalidateQueries({ queryKey: ["execution-status"] }),
        qc.invalidateQueries({ queryKey: ["trust-center-feed"] }),
        qc.invalidateQueries({ queryKey: ["mainnet-accumulator-connection"] }),
      ]);
    },
  });



  const latest = latestQ.data ?? null;
  // Mainnet-class environments: apex_omni exposes `production`; some legacy
  // rows use `mainnet` or `live`. Kept in sync with MAINNET_ENVIRONMENTS in
  // src/components/turtle/ExecutionStatusChip.tsx.
  const isMainnetClass =
    environment === "mainnet" ||
    environment === "production" ||
    environment === "live";
  const eligible = useMemo(
    () =>
      isMainnetClass &&
      isLive &&
      roleQ.data === true &&
      permissionTrade &&
      permissionsVerified &&
      connectionStatus === "verified",
    [connectionStatus, isMainnetClass, isLive, permissionTrade, permissionsVerified, roleQ.data],
  );
  const canRegister = useMemo(
    () => isMainnetClass && isLive && roleQ.data === true,
    [isMainnetClass, isLive, roleQ.data],
  );
  const activeInFlight =
    latest && (latest.status === "pending" || latest.status === "consumed");

  if (!user || roleQ.isLoading) return null;
  if (!roleQ.data) return null;

  const stateLabel = (() => {
    if (!latest) return "Idle";
    if (latest.status === "pending") return "Pending — waiting for worker";
    if (latest.status === "consumed") return "Claimed — submitting";
    if (latest.status === "completed") return "Completed";
    if (latest.status === "failed") return "Failed";
    return latest.status;
  })();

  const outcome = (latest?.result ?? {}) as Record<string, unknown>;
  const orderId =
    typeof outcome.exchange_order_id === "string" ? outcome.exchange_order_id : null;
  const reject =
    typeof outcome.reject_reason === "string" ? outcome.reject_reason : null;
  const err = friendlyError(latest?.error_message ?? reject);
  const built =
    outcome.built && typeof outcome.built === "object"
      ? (outcome.built as Record<string, unknown>)
      : null;
  const builtStr = (k: string): string | null => {
    const v = built?.[k];
    return typeof v === "string" || typeof v === "number" ? String(v) : null;
  };
  const isUnprotectedProof =
    latest?.status === "completed" &&
    outcome.proof_of_life === true &&
    outcome.unprotected === true;

  return (
    <SurfaceCard className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-emerald-300" />
            <h3 className="text-[14px] font-semibold text-white">
              Proof of Life
            </h3>
          </div>
          <p className="mt-1 text-[11.5px] text-white/60">
            Fires ONE minimum-size live intent through the broker → signer →
            venue pipeline. Signer's canary clamp caps the notional.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            type="button"
            disabled={!eligible || inflight || Boolean(activeInFlight)}
            onClick={() => fire.mutate()}
            className={cn(
              "rounded-xl px-3 py-2 text-[11.5px] font-semibold transition",
              eligible && !activeInFlight
                ? "bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                : "cursor-not-allowed bg-white/[0.05] text-white/40",
            )}
          >
            {inflight || activeInFlight ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working
              </span>
            ) : (
              "Fire proof-of-life trade"
            )}
          </button>
          <button
            type="button"
            disabled={!canRegister || register.isPending}
            onClick={() => register.mutate()}
            className={cn(
              "rounded-xl px-3 py-1.5 text-[10.5px] font-semibold transition",
              canRegister && !register.isPending
                ? "bg-sky-500/15 text-sky-200 hover:bg-sky-500/25"
                : "cursor-not-allowed bg-white/[0.05] text-white/40",
            )}
            title="Mint an ApeX account for this wallet"
          >
            {register.isPending ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Registering
              </span>
            ) : (
              "Register account for trading"
            )}
          </button>
        </div>
      </div>

      {register.data?.ok && (
        <div className="mt-3 rounded-xl bg-emerald-500/[0.08] p-2.5 text-[11px] text-emerald-100">
          Account registered — REST credentials stored. Fire proof-of-life to verify routing.
        </div>
      )}
      {register.error && (
        <div className="mt-3 rounded-xl bg-red-500/[0.08] p-2.5 text-[11px] text-red-200">
          Register failed: {(register.error as Error).message}
        </div>
      )}
      {reject === "ACCOUNT_NOT_REGISTERED" && !register.data?.ok && (
        <div className="mt-3 rounded-xl bg-amber-500/[0.08] p-2.5 text-[11px] text-amber-100">
          ApeX has no account for this wallet yet. Click <b>Register account for trading</b> above.
        </div>
      )}

      {!eligible && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-500/[0.08] p-2.5 text-[11px] text-amber-100">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {!isMainnetClass || !isLive
              ? "Requires a mainnet connection with Live trading enabled."
              : !permissionTrade || !permissionsVerified || connectionStatus !== "verified"
                ? "Register account for trading first. Successful registration verifies the connection and unlocks proof-of-life."
                : "Waiting for owner permission."}
          </span>
        </div>
      )}


      {parityQ.data && (
        <div
          className={cn(
            "mt-3 rounded-xl p-2.5 text-[11px]",
            parityQ.data.match
              ? "bg-emerald-500/[0.06] text-emerald-100/85"
              : "bg-red-500/[0.08] text-red-100",
          )}
        >
          <div className="flex items-center justify-between gap-2 font-semibold">
            <span>REST key parity</span>
            <span>{parityQ.data.match ? "MATCH" : "MISMATCH"}</span>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 font-mono text-[10.5px] opacity-80">
            <div>edge: {parityQ.data.edge_key_fingerprint}</div>
            <div>signer: {parityQ.data.signer_key_fingerprint ?? "—"}</div>
          </div>
          {!parityQ.data.match && (
            <div className="mt-1.5 text-[10.5px] opacity-90">
              {parityQ.data.signer_error
                ? `Signer: ${parityQ.data.signer_error}`
                : "Set TURTLE_CREDENTIAL_ENCRYPTION_KEY to the same UTF-8 value on Railway and the edge, then re-save the ApeX API key."}
            </div>
          )}
        </div>
      )}


      {latest && (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[11.5px] text-white/85">
          <div>
            <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">
              State
            </dt>
            <dd className="mt-0.5">{stateLabel}</dd>
          </div>
          <div>
            <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">
              Symbol
            </dt>
            <dd className="mt-0.5">{latest.symbol ?? "—"}</dd>
          </div>
          {orderId && (
            <div className="col-span-2">
              <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">
                Exchange order id
              </dt>
              <dd className="mt-0.5 truncate font-mono">{orderId}</dd>
            </div>
          )}
          {built && (
            <>
              <div>
                <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">
                  Sent size
                </dt>
                <dd className="mt-0.5 font-mono">
                  {builtStr("size") ?? "—"} {builtStr("symbol")?.split("-")[0] ?? ""}
                </dd>
              </div>
              <div>
                <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">
                  Notional
                </dt>
                <dd className="mt-0.5 font-mono">
                  ${builtStr("notional_usd") ?? "—"}
                  {builtStr("leverage") ? ` · ${builtStr("leverage")}x` : ""}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">
                  Protected price
                </dt>
                <dd className="mt-0.5 font-mono">
                  ${builtStr("protected_price") ?? "—"}
                  {builtStr("mark_price") ? ` (mark $${builtStr("mark_price")})` : ""}
                </dd>
              </div>
            </>
          )}
          {isUnprotectedProof && (
            <div className="col-span-2 rounded-xl bg-amber-500/[0.10] p-2.5 text-[11px] text-amber-100">
              <b>No protective stop attached</b> for this test order (owner-directed).
              The position is UNPROTECTED until closed manually on ApeX.
            </div>
          )}
          {err && (
            <div className="col-span-2 rounded-xl bg-red-500/[0.08] p-2.5 text-[11px] text-red-200">
              {err}
            </div>
          )}
        </dl>
      )}

      {fire.error && (
        <div className="mt-3 rounded-xl bg-red-500/[0.08] p-2.5 text-[11px] text-red-200">
          {(fire.error as Error).message || "Insert failed"}
        </div>
      )}

      {/* Strategy-path test — same broker → signer → venue pipeline as a real
          signal, with attached stop + H2 TP ladder. No exemption flags; only
          size is canary-clamped by the signer. */}
      <div className="mt-5 border-t border-white/[0.06] pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-sky-300" />
              <h4 className="text-[13px] font-semibold text-white">
                Strategy path test
              </h4>
            </div>
            <p className="mt-1 text-[11px] text-white/60">
              Fires ONE canary-sized order through the FULL live strategy
              pipeline (purpose=CREATE_ORDER, attached stop, H2 TP ladder
              50/30/20 @ 1.75/2.0/2.5R). Identical code path to a real
              signal.
            </p>
          </div>
          <button
            type="button"
            disabled={!eligible || fireStrategy.isPending || Boolean(latestStratQ.data && (latestStratQ.data.status === "pending" || latestStratQ.data.status === "consumed"))}
            onClick={() => fireStrategy.mutate()}
            className={cn(
              "shrink-0 rounded-xl px-3 py-2 text-[11.5px] font-semibold transition",
              eligible ? "bg-sky-500/15 text-sky-200 hover:bg-sky-500/25"
                : "cursor-not-allowed bg-white/[0.05] text-white/40",
            )}
          >
            {fireStrategy.isPending || (latestStratQ.data && (latestStratQ.data.status === "pending" || latestStratQ.data.status === "consumed")) ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working
              </span>
            ) : (
              "Fire test strategy order"
            )}
          </button>
        </div>

        {latestStratQ.data && (() => {
          const s = latestStratQ.data;
          const so = (s.result ?? {}) as Record<string, unknown>;
          const sid = typeof so.exchange_order_id === "string" ? so.exchange_order_id : null;
          const sbuilt = so.built && typeof so.built === "object" ? so.built as Record<string, unknown> : null;
          const sprotIds = so.protection_venue_ids && typeof so.protection_venue_ids === "object"
            ? so.protection_venue_ids as Record<string, unknown> : null;
          const serr = friendlyError(s.error_message ?? (typeof so.reject_reason === "string" ? so.reject_reason : null));
          const sst = (() => {
            if (s.status === "pending") return "Pending — waiting for worker";
            if (s.status === "consumed") return "Claimed — submitting";
            if (s.status === "completed") return "Completed";
            if (s.status === "failed") return "Failed";
            return s.status;
          })();
          return (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[11.5px] text-white/85">
              <div>
                <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">State</dt>
                <dd className="mt-0.5">{sst}</dd>
              </div>
              <div>
                <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">Symbol</dt>
                <dd className="mt-0.5">{s.symbol ?? "—"}</dd>
              </div>
              {sid && (
                <div className="col-span-2">
                  <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">Entry venue id</dt>
                  <dd className="mt-0.5 truncate font-mono">{sid}</dd>
                </div>
              )}
              {sbuilt && (
                <>
                  <div>
                    <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">Sent size</dt>
                    <dd className="mt-0.5 font-mono">{String(sbuilt.size ?? "—")}</dd>
                  </div>
                  <div>
                    <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">Notional</dt>
                    <dd className="mt-0.5 font-mono">${String(sbuilt.notional_usd ?? "—")}</dd>
                  </div>
                </>
              )}
              {sprotIds && (
                <div className="col-span-2">
                  <dt className="text-[9.5px] font-bold uppercase tracking-widest text-white/45">Attached protections</dt>
                  <dd className="mt-0.5 space-y-0.5 font-mono text-[10.5px]">
                    {Object.entries(sprotIds).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <span className="text-white/60">{k}</span>
                        <span className="truncate">{String(v)}</span>
                      </div>
                    ))}
                  </dd>
                </div>
              )}
              {serr && (
                <div className="col-span-2 rounded-xl bg-red-500/[0.08] p-2.5 text-[11px] text-red-200">
                  {serr}
                </div>
              )}
            </dl>
          );
        })()}
        {fireStrategy.error && (
          <div className="mt-3 rounded-xl bg-red-500/[0.08] p-2.5 text-[11px] text-red-200">
            {(fireStrategy.error as Error).message || "Insert failed"}
          </div>
        )}
      </div>
    </SurfaceCard>
  );
}
