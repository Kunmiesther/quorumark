/**
 * Section 4 — Safety Center.
 *
 * WHAT IS WIRED, AND WHAT DELIBERATELY IS NOT
 * -------------------------------------------
 * Emergency stop pauses live routing on every connection by clearing
 * `exchange_connections.is_live` — the app-level authority that
 * `LiveTradingToggle` already owns — and additionally records a kill switch.
 * It uses existing authority; it invents no new execution path.
 *
 * Resume is deliberately NOT global. Stopping everything at once is always
 * safe; starting everything at once is not, because it could re-enable a
 * venue the owner had intentionally left off. Resume is per-exchange, in the
 * connections list, one deliberate act at a time.
 *
 * Close all positions and Cancel open orders call owner-only server actions.
 * The browser supplies only an owned connection id. The broker obtains the
 * authoritative position/order snapshot from the private signer and derives
 * reduce-only exits there; browser-provided symbols, sides and sizes are never
 * trusted.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, OctagonX, ShieldAlert, XOctagon } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import {
  ActionButton,
  Metric,
  SectionHeading,
  fmtUsd,
  type Tone,
} from "@/components/exchanges/trust/primitives";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { executeLiveSafetyAction, type LiveSafetyOperation } from "@/lib/live/liveSafety.functions";
import { cn } from "@/lib/utils";

export interface RiskProfile {
  dailyLossUsd: number | null;
  dailyLossLimitUsd: number | null;
  exposureUsd: number | null;
  exposureLimitUsd: number | null;
  maxLeverage: number | null;
  marginUsedUsd: number | null;
}

/** Utilisation tone. `null` inputs stay unknown — never optimistic. */
function utilisationTone(used: number | null, limit: number | null): Tone {
  if (used === null || limit === null || limit <= 0) return "unknown";
  const pct = used / limit;
  if (pct >= 1) return "down";
  if (pct >= 0.75) return "warn";
  return "ok";
}

export function SafetyCenterPanel({
  risk,
  halted,
  liveConnectionIds,
  safetyConnectionIds,
}: {
  risk: RiskProfile;
  halted: boolean;
  /** Connections currently routing live orders. Empty = nothing to stop. */
  liveConnectionIds: string[];
  /** Verified mainnet connections where risk-reducing actions are available. */
  safetyConnectionIds: string[];
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [safetyConfirm, setSafetyConfirm] = useState<LiveSafetyOperation | null>(null);

  const emergencyStop = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not signed in");
      // 1. Clear the app-level live flag on every connection. This is the
      //    same authority the per-exchange toggle uses, so it is guaranteed
      //    to be permitted and to take effect immediately.
      if (liveConnectionIds.length > 0) {
        const { error } = await supabase
          .from("exchange_connections")
          .update({ is_live: false })
          .in("id", liveConnectionIds);
        if (error) throw error;
      }
      // 2. Record a kill switch as defence in depth. This table is
      //    service-role write in some deployments, so a refusal here must not
      //    undo step 1 — the pause already happened and is what matters.
      const { error: killError } = await supabase.from("kill_switches").insert({
        user_id: user.id,
        scope: "user",
        active: true,
        reason: "user_ui_emergency_stop",
      });
      return { killSwitchRecorded: !killError };
    },
    onSuccess: (result) => {
      toast.success(
        liveConnectionIds.length > 0
          ? `Live routing paused on ${liveConnectionIds.length} connection${liveConnectionIds.length === 1 ? "" : "s"}.`
          : "No connection was routing live orders.",
      );
      if (!result.killSwitchRecorded) {
        // Truthful partial outcome. Silence here would overstate the result.
        toast.message("Kill switch not recorded", {
          description:
            "Live routing is paused, but the server-side kill switch could not be written from the browser. Existing positions are untouched.",
        });
      }
      qc.invalidateQueries({ queryKey: ["exchange-connections-full"] });
      qc.invalidateQueries({ queryKey: ["kill-switches-any"] });
      qc.invalidateQueries({ queryKey: ["trust-center-feed"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not pause live trading."),
  });

  const nothingLive = liveConnectionIds.length === 0;
  const noSafetyConnections = safetyConnectionIds.length === 0;

  const safetyAction = useMutation({
    mutationFn: async (operation: LiveSafetyOperation) => {
      const results = await Promise.allSettled(
        safetyConnectionIds.map((connectionId) =>
          executeLiveSafetyAction({ data: { connectionId, operation } }),
        ),
      );
      const successes = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const rejected = results.length - successes.length;
      return {
        operation,
        found: successes.reduce((sum, result) => sum + result.found, 0),
        completed: successes.reduce((sum, result) => sum + result.completed, 0),
        failed: rejected + successes.reduce((sum, result) => sum + result.failed, 0),
        details: successes.map((result) => result.detail).filter(Boolean),
      };
    },
    onSuccess: (result) => {
      const noun = result.operation === "close_all" ? "position close" : "order cancellation";
      if (result.failed > 0) {
        toast.warning(`${noun} partially completed`, {
          description:
            `${result.completed} completed, ${result.failed} failed. ${result.details.join("; ")}`.trim(),
        });
      } else if (result.found === 0) {
        toast.success(
          result.operation === "close_all" ? "No open positions found." : "No open orders found.",
        );
      } else {
        toast.success(
          result.operation === "close_all"
            ? `${result.completed} reduce-only close${result.completed === 1 ? "" : "s"} submitted.`
            : `${result.completed} open order${result.completed === 1 ? "" : "s"} cancelled.`,
        );
      }
      qc.invalidateQueries({ queryKey: ["trust-center-feed"] });
      qc.invalidateQueries({ queryKey: ["live-positions"] });
      qc.invalidateQueries({ queryKey: ["live-orders"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Safety action failed."),
  });

  return (
    <SurfaceCard>
      <SectionHeading
        title="Safety center"
        subtitle="Immediate controls and the limits currently in force."
      />

      {halted && (
        <div className="mb-4 flex items-start gap-2.5 rounded-2xl bg-amber-500/[0.1] p-3.5">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <p className="text-[11.5px] leading-relaxed text-amber-100">
            <span className="font-semibold">Emergency stop is active.</span> No new orders will be
            placed. Existing positions and resting orders are untouched — resume per exchange in the
            connections list when you are ready.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ActionButton
          label={nothingLive ? "Nothing routing live" : "Emergency stop"}
          icon={<OctagonX className="h-3.5 w-3.5" />}
          danger
          disabled={nothingLive || emergencyStop.isPending}
          disabledReason={
            nothingLive ? "No connection is currently routing live orders." : undefined
          }
          pending={emergencyStop.isPending}
          onClick={() => setConfirmOpen(true)}
        />
        <ActionButton
          label="Resume trading"
          disabled
          disabledReason="Resume is per exchange, in the connections list below — deliberately, so nothing restarts a venue you left off."
        />
        <ActionButton
          label="Close all positions"
          icon={<XOctagon className="h-3.5 w-3.5" />}
          danger
          disabled={noSafetyConnections || safetyAction.isPending}
          disabledReason={
            noSafetyConnections ? "No verified ApeX mainnet connection is available." : undefined
          }
          pending={safetyAction.isPending && safetyAction.variables === "close_all"}
          onClick={() => setSafetyConfirm("close_all")}
        />
        <ActionButton
          label="Cancel open orders"
          icon={<Ban className="h-3.5 w-3.5" />}
          disabled={noSafetyConnections || safetyAction.isPending}
          disabledReason={
            noSafetyConnections ? "No verified ApeX mainnet connection is available." : undefined
          }
          pending={safetyAction.isPending && safetyAction.variables === "cancel_all"}
          onClick={() => setSafetyConfirm("cancel_all")}
        />
      </div>

      <p className="mt-2.5 text-[10.5px] leading-relaxed text-white/35">
        Emergency stop pauses live routing on every connection. It never closes a position, cancels
        an order, or moves funds.
      </p>

      <div className="mt-5 border-t border-white/[0.06] pt-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric
            label="Daily loss"
            value={
              risk.dailyLossUsd === null
                ? "—"
                : `${fmtUsd(risk.dailyLossUsd)}${
                    risk.dailyLossLimitUsd ? ` / ${fmtUsd(risk.dailyLossLimitUsd)}` : ""
                  }`
            }
            tone={utilisationTone(risk.dailyLossUsd, risk.dailyLossLimitUsd)}
          />
          <Metric
            label="Exposure"
            value={
              risk.exposureUsd === null
                ? "—"
                : `${fmtUsd(risk.exposureUsd)}${
                    risk.exposureLimitUsd ? ` / ${fmtUsd(risk.exposureLimitUsd)}` : ""
                  }`
            }
            tone={utilisationTone(risk.exposureUsd, risk.exposureLimitUsd)}
          />
          <Metric
            label="Max leverage"
            value={risk.maxLeverage === null ? "—" : `${risk.maxLeverage}x`}
          />
          <Metric label="Current margin" value={fmtUsd(risk.marginUsedUsd)} />
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Pause live trading everywhere?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 pt-1 text-[12.5px] leading-relaxed">
                <p>
                  Live routing will be switched off on{" "}
                  <b>
                    {liveConnectionIds.length} connection
                    {liveConnectionIds.length === 1 ? "" : "s"}
                  </b>
                  . TurtleBot will stop placing new orders immediately.
                </p>
                <p>
                  Your existing positions and resting orders are <b>not</b> touched. Nothing is
                  closed, cancelled, or withdrawn.
                </p>
                <p>Resuming is per exchange, so nothing restarts by itself.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="min-h-[36px] rounded-xl bg-white/[0.06] px-4 text-[12px] font-semibold text-white/75 transition hover:bg-white/[0.1]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                emergencyStop.mutate();
              }}
              className={cn(
                "min-h-[36px] rounded-xl px-4 text-[12px] font-semibold text-white transition",
                "bg-red-500/90 hover:bg-red-500",
              )}
            >
              Pause live trading
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={safetyConfirm !== null}
        onOpenChange={(open) => !open && setSafetyConfirm(null)}
      >
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {safetyConfirm === "close_all"
                ? "Close every open position?"
                : "Cancel every open order?"}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 pt-1 text-[12.5px] leading-relaxed">
                {safetyConfirm === "close_all" ? (
                  <>
                    <p>
                      TurtleBot will read the current ApeX venue positions and submit one market,
                      reduce-only exit for each supported open position.
                    </p>
                    <p>
                      It will not withdraw funds, open a reverse position, or resume automation.
                    </p>
                  </>
                ) : (
                  <p>
                    TurtleBot will read the current ApeX open-order book and cancel every order that
                    has a venue client-order ID. Positions remain open.
                  </p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <button
              type="button"
              onClick={() => setSafetyConfirm(null)}
              className="min-h-[36px] rounded-xl bg-white/[0.06] px-4 text-[12px] font-semibold text-white/75 transition hover:bg-white/[0.1]"
            >
              Keep current state
            </button>
            <button
              type="button"
              onClick={() => {
                const operation = safetyConfirm;
                setSafetyConfirm(null);
                if (operation) safetyAction.mutate(operation);
              }}
              className={cn(
                "min-h-[36px] rounded-xl px-4 text-[12px] font-semibold text-white transition",
                safetyConfirm === "close_all"
                  ? "bg-red-500/90 hover:bg-red-500"
                  : "bg-amber-500/90 hover:bg-amber-500",
              )}
            >
              {safetyConfirm === "close_all" ? "Submit reduce-only exits" : "Cancel open orders"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SurfaceCard>
  );
}
