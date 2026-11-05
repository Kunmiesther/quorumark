import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, PowerOff, AlertTriangle, ShieldAlert, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";

type Props = {
  connectionId: string;
  connectionLabel: string;
  status: string;
  onChange?: () => void;
};

type PreflightResponse = {
  ok: boolean;
  open_positions: number | null;
  can_verify: boolean;
  code?: string;
  message?: string;
};

type MutationResponse = { ok?: boolean; code?: string; message?: string };

/**
 * Per-bay lifecycle controls.
 *
 * Guarantees:
 *  - Pause is server-authoritative (writes a connection-scope kill switch).
 *  - Safe Disconnect is preflight-gated: if the venue reports open positions
 *    we require the user to explicitly acknowledge. We NEVER auto-close.
 *  - Every action is written to `connection_audit_events` by the backend.
 */
export function BayControls({ connectionId, connectionLabel, status, onChange }: Props) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<null | "disconnect">(null);
  const [acknowledge, setAcknowledge] = useState(false);

  const isPaused = status === "paused";
  const isDisconnected = status === "disconnected" || status === "disabled";

  function refresh() {
    qc.invalidateQueries({ queryKey: ["trade-bays-connections", user?.id] });
    qc.invalidateQueries({ queryKey: ["exchange-connections", user?.id] });
    qc.invalidateQueries({ queryKey: ["exchange-health", user?.id] });
    qc.invalidateQueries({ queryKey: ["connection-audit", user?.id] });
    onChange?.();
  }

  const pause = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke<MutationResponse>(
        "exchange-credentials",
        { body: { action: "pause", connection_id: connectionId } },
      );
      if (error || !data?.ok) throw new Error(data?.message ?? "Could not pause.");
    },
    onSuccess: () => {
      toast.success("Bay paused");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resume = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke<MutationResponse>(
        "exchange-credentials",
        { body: { action: "resume", connection_id: connectionId } },
      );
      if (error || !data?.ok) throw new Error(data?.message ?? "Could not resume.");
    },
    onSuccess: () => {
      toast.success("Bay resumed");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const preflight = useQuery({
    queryKey: ["disconnect-preflight", connectionId],
    enabled: dialog === "disconnect",
    staleTime: 0,
    gcTime: 0,
    queryFn: async (): Promise<PreflightResponse> => {
      const { data, error } = await supabase.functions.invoke<PreflightResponse>(
        "exchange-credentials",
        { body: { action: "preflight_disconnect", connection_id: connectionId } },
      );
      if (error) throw new Error("Could not check open positions.");
      return data ?? { ok: false, open_positions: null, can_verify: false };
    },
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke<MutationResponse>(
        "exchange-credentials",
        {
          body: {
            action: "disconnect",
            connection_id: connectionId,
            acknowledge_positions: acknowledge,
          },
        },
      );
      if (error || !data?.ok) throw new Error(data?.message ?? "Could not disconnect.");
    },
    onSuccess: () => {
      toast.success("Connection disconnected");
      setDialog(null);
      setAcknowledge(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openPositions = preflight.data?.open_positions ?? null;
  const canVerify = preflight.data?.can_verify ?? false;
  const hasOpen = typeof openPositions === "number" && openPositions > 0;

  return (
    <>
      <div className="mt-3 flex gap-2">
        {isPaused ? (
          <button
            type="button"
            disabled={resume.isPending}
            onClick={() => resume.mutate()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-primary)] transition hover:bg-white/[0.06] disabled:opacity-60"
          >
            {resume.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Resume
          </button>
        ) : (
          <button
            type="button"
            disabled={pause.isPending || isDisconnected}
            onClick={() => pause.mutate()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-primary)] transition hover:bg-white/[0.06] disabled:opacity-40"
          >
            {pause.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
            Pause
          </button>
        )}
        <button
          type="button"
          disabled={isDisconnected}
          onClick={() => {
            setAcknowledge(false);
            setDialog("disconnect");
          }}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[color:var(--warn-amber)]/30 bg-[color:var(--warn-amber)]/[0.06] px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--warn-amber)] transition hover:bg-[color:var(--warn-amber)]/[0.12] disabled:opacity-40"
        >
          <PowerOff className="h-3 w-3" />
          Safe Disconnect
        </button>
      </div>

      <Dialog open={dialog === "disconnect"} onOpenChange={(v) => { if (!v) { setDialog(null); setAcknowledge(false); } }}>
        <DialogContent className="max-w-sm border-white/10 bg-[#0F1118]">
          <DialogTitle className="font-display text-[15px] font-semibold uppercase tracking-[0.06em]">
            Safe Disconnect · {connectionLabel}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-[color:var(--text-secondary)]">
            TurtleBot will never auto-close your positions. Close them on the exchange first, or acknowledge that you accept the risk.
          </DialogDescription>

          <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
            {preflight.isLoading ? (
              <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-secondary)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking open positions…
              </div>
            ) : preflight.isError || !canVerify ? (
              <div className="flex items-start gap-2 text-[12px] text-[color:var(--warn-amber)]">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>We could not verify open positions with the venue. Try again in a moment.</span>
              </div>
            ) : hasOpen ? (
              <div className="flex items-start gap-2 text-[12px] text-[color:var(--warn-amber)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong className="num">{openPositions}</strong> open position{openPositions === 1 ? "" : "s"} still on this connection. Disconnecting does not close them.
                </span>
              </div>
            ) : (
              <p className="text-[12px] text-[color:var(--verified,#73FFB8)]">No open positions detected. Safe to disconnect.</p>
            )}
          </div>

          {hasOpen && canVerify && (
            <label className="mt-3 flex items-start gap-2 text-[12px] text-[color:var(--text-secondary)]">
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(e) => setAcknowledge(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--warn-amber)]"
              />
              <span>
                I understand my {openPositions} open position{openPositions === 1 ? "" : "s"} will remain on the exchange after I disconnect.
              </span>
            </label>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => { setDialog(null); setAcknowledge(false); }}
              className="flex-1 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[color:var(--text-secondary)] transition hover:bg-white/[0.06]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={
                disconnect.isPending ||
                preflight.isLoading ||
                !canVerify ||
                (hasOpen && !acknowledge)
              }
              onClick={() => disconnect.mutate()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[color:var(--warn-amber)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#0B0C10] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {disconnect.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              Disconnect
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
