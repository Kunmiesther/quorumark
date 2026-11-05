// Live trading toggle for a single exchange connection.
// Writes exchange_connections.is_live. Owner-scoped by RLS (auth.uid()=user_id).
//
// Truthfulness: this flag is the app-level authoritative "this connection is
// authorized to route real orders". Process-level gates (LIVE_TRADING_ENABLED
// on the worker, APEX_MAINNET_SIGNER_ENABLED / APEX_MAINNET_CANARY_ENABLED on
// the signer) are independent defense-in-depth switches. See docs/LIVE_ACTIVATION.md.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Radio } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import {
  canUseInternalLiveTrading,
  liveTradingAvailabilityCopy,
} from "@/lib/live-trading-policy";
import { useIsOwner } from "@/hooks/useIsOwner";
import { cn } from "@/lib/utils";

export function LiveTradingToggle({
  connectionId,
  isLive,
  environment,
  permissionTrade,
  permissionsVerified,
}: {
  connectionId: string;
  isLive: boolean;
  environment: string;
  permissionTrade: boolean;
  permissionsVerified: boolean;
}) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const { isOwner, isReady: ownerReady } = useIsOwner();
  const liveAvailable = canUseInternalLiveTrading(isOwner);
  const availabilityCopy = liveTradingAvailabilityCopy(isOwner);

  const mut = useMutation({
    mutationFn: async (next: boolean) => {
      if (next && !liveAvailable) {
        throw new Error(availabilityCopy);
      }
      setPending(true);
      const { error } = await supabase
        .from("exchange_connections")
        .update({ is_live: next })
        .eq("id", connectionId);
      if (error) throw error;
      return next;
    },
    onSettled: async () => {
      setPending(false);
      await qc.invalidateQueries({ queryKey: ["exchange-connections-full"] });
    },
  });

  const isMainnet = environment === "mainnet" || environment === "production";
  const executionEligible = permissionTrade && permissionsVerified;
  const effectiveLive = isLive && executionEligible;
  // An already-live connection can always be turned off. Turning one on is
  // blocked until the compliance policy is approved.
  const disabled =
    pending ||
    mut.isPending ||
    !ownerReady ||
    !isMainnet ||
    (!isLive && !liveAvailable);

  return (
    <div className="mt-4 rounded-xl bg-white/[0.04] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Radio
              className={cn(
                "h-3.5 w-3.5",
                effectiveLive
                  ? "text-emerald-300"
                  : isLive
                    ? "text-amber-300"
                    : "text-white/40",
              )}
            />
            <p className="text-[12.5px] font-semibold text-white">Live trading</p>
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-widest",
                effectiveLive
                  ? "bg-emerald-500/15 text-emerald-200"
                  : isLive
                    ? "bg-amber-500/15 text-amber-200"
                  : "bg-white/[0.06] text-white/60",
              )}
            >
              {effectiveLive ? "On" : isLive ? "Blocked" : "Off"}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-white/55">
            {isLive && !executionEligible
              ? "Live routing was requested, but the venue has not verified trading permission. Register or reconnect the account before any order can route."
              : isMainnet
              ? liveAvailable
                ? "When on, this connection is authorized to route real orders. The worker and signer still enforce their own gates."
                : availabilityCopy
              : "Live trading can only be enabled on a mainnet connection."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={effectiveLive}
          disabled={disabled}
          onClick={() => mut.mutate(!isLive)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition",
            effectiveLive ? "bg-emerald-500/80" : isLive ? "bg-amber-500/70" : "bg-white/15",
            disabled && "opacity-60",
          )}
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
              isLive ? "translate-x-5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
      {mut.isError && (
        <p className="mt-2 text-[11px] text-red-300">
          Unable to update. {(mut.error as Error)?.message ?? ""}
        </p>
      )}
    </div>
  );
}
