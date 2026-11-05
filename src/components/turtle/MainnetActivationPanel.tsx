// Mainnet Activation Panel — UI-only replacement for "Mainnet Locked".
//
// Surfaces the exact pilot preconditions and, when the owner types the
// confirmation phrase, reveals the truthful blocker: server-side signer /
// canary flags are held by the operator and cannot be flipped from the app.
// No schema changes, no credentials exposed, no persistence.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from "lucide-react";

import { CommandPanel } from "@/components/command/CommandPanel";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useBotHealth } from "@/hooks/useBotHealth";
import { usePortfolioTotals } from "@/hooks/usePortfolioTotals";
import { CUSTOMER_LIVE_TRADING_BLOCK_REASON } from "@/lib/live-trading-policy";
import { cn } from "@/lib/utils";

const PILOT_MIN_USD = 100;
const PILOT_MAX_USD = 500;
const CONFIRM_PHRASE = "ACTIVATE MAINNET";

type Gate = { key: string; label: string; ok: boolean; detail: string };

function GateRow({ gate }: { gate: Gate }) {
  const Icon = gate.ok ? CheckCircle2 : XCircle;
  return (
    <li
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3 py-2",
        gate.ok
          ? "border-emerald-500/25 bg-emerald-500/[0.06]"
          : "border-amber-500/25 bg-amber-500/[0.06]",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          gate.ok ? "text-emerald-300" : "text-amber-300",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-foreground">{gate.label}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {gate.detail}
        </p>
      </div>
    </li>
  );
}

export function MainnetActivationPanel() {
  const { user } = useAuth();
  const health = useBotHealth();
  const portfolio = usePortfolioTotals();
  const [confirm, setConfirm] = useState("");
  const [requested, setRequested] = useState(false);

  // Accumulator connection = the single verified apex_omni mainnet
  // (environment=production) connection owned by the user.
  const connQ = useQuery({
    queryKey: ["mainnet-accumulator-connection", user?.id],
    enabled: !!user,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select(
          "id, exchange, environment, status, permission_read, permission_trade, permissions_verified, permission_verified_at, withdrawals_disabled",
        )
        .eq("user_id", user!.id)
        .eq("exchange", "apex_omni")
        .eq("environment", "production")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const conn = connQ.data ?? null;

  const hasConn = !!conn;
  const connVerified = conn?.status === "verified";
  const permsVerified = !!conn?.permissions_verified;
  const canTrade = !!conn?.permission_trade;
  const withdrawalsDisabled = !!conn?.withdrawals_disabled;

  const availableUsd = portfolio.available;
  const meetsFloor = availableUsd >= PILOT_MIN_USD;
  const noKillSwitch = health.killSwitches.length === 0;

  const gates: Gate[] = useMemo(
    () => [
      {
        key: "compliance",
        label: "Jurisdiction and licensing approval",
        ok: false,
        detail: CUSTOMER_LIVE_TRADING_BLOCK_REASON,
      },
      {
        key: "connection",
        label: "Mainnet Arbiter connection",
        ok: hasConn && connVerified,
        detail: !hasConn
          ? "No apex_omni production connection found."
          : !connVerified
            ? `Connection status is "${conn?.status}". Verify credentials first.`
            : "ApeX Omni mainnet connection verified.",
      },
      {
        key: "permissions",
        label: "Permissions verified · trade scope",
        ok: permsVerified && canTrade,
        detail: !permsVerified
          ? "Permissions have not been verified yet."
          : !canTrade
            ? "Connection lacks trade permission. Withdrawal must remain disabled."
            : `Trade allowed · withdrawals ${withdrawalsDisabled ? "disabled" : "NOT disabled — refuse"}.`,
      },
      {
        key: "balance",
        label: `Available balance ≥ $${PILOT_MIN_USD}`,
        ok: meetsFloor,
        detail: portfolio.isLoading
          ? "Loading balances…"
          : `Available: $${availableUsd.toFixed(2)} · Floor: $${PILOT_MIN_USD} · Cap: $${PILOT_MAX_USD}`,
      },
      {
        key: "kill",
        label: "No active kill switch",
        ok: noKillSwitch,
        detail: noKillSwitch
          ? "Global kill switch clear."
          : `Halt active (${health.killSwitches.map((k) => k.scope).join(", ")}).`,
      },
    ],
    [
      hasConn,
      connVerified,
      conn?.status,
      permsVerified,
      canTrade,
      withdrawalsDisabled,
      meetsFloor,
      portfolio.isLoading,
      availableUsd,
      noKillSwitch,
      health.killSwitches,
    ],
  );

  const allPass = gates.every((g) => g.ok);
  const phraseOk = confirm.trim() === CONFIRM_PHRASE;
  const canRequest = allPass && phraseOk && !requested;

  return (
    <CommandPanel
      title="Mainnet activation"
      subtitle="Read-only until jurisdiction and licensing approval is complete"
    >
      <div className="flex items-start gap-2.5 rounded-xl border border-cyan-500/25 bg-cyan-500/[0.06] p-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
        <p className="text-[11.5px] leading-snug text-cyan-100/90">
          ApeX may be connected for read-only account monitoring. Live execution cannot be
          activated until TurtleBot's jurisdiction and licensing policy is approved. Credentials
          and secrets are never displayed here.
        </p>
      </div>

      <ul className="mt-3 grid gap-2">
        {gates.map((g) => (
          <GateRow key={g.key} gate={g} />
        ))}
      </ul>

      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <label
          htmlFor="mainnet-confirm"
          className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground"
        >
          Type <span className="font-mono text-foreground">{CONFIRM_PHRASE}</span> to enable the button
        </label>
        <input
          id="mainnet-confirm"
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={!allPass || requested}
          className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:border-cyan-400/50 focus:outline-none disabled:opacity-50"
          placeholder={allPass ? CONFIRM_PHRASE : "Resolve the blockers above first"}
        />

        <button
          type="button"
          disabled={!canRequest}
          onClick={() => setRequested(true)}
          className={cn(
            "mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[12.5px] font-semibold transition",
            canRequest
              ? "bg-red-500/90 text-white hover:bg-red-500"
              : "bg-white/[0.04] text-muted-foreground",
          )}
        >
          {requested ? "Activation requested" : "Activate mainnet canary"}
        </button>

        {requested ? (
          <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-amber-100">
                Activation unavailable — signer canary disabled
              </p>
              <p className="mt-1 text-[11.5px] leading-snug text-amber-100/85">
                Live execution requires the operator to enable{" "}
                <span className="font-mono">APEX_MAINNET_SIGNER_ENABLED</span> and{" "}
                <span className="font-mono">APEX_MAINNET_CANARY_ENABLED</span> on
                the signer, plus the <span className="font-mono">SIGN_ORDER</span>{" "}
                operation flag. These are held server-side and cannot be flipped
                from the app. Your pre-flight state has been recorded locally;
                no order has been submitted.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </CommandPanel>
  );
}
