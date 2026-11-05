import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { venueLabel } from "@/lib/venue-logos";
import { ApexOmniLogo } from "@/components/brand/ApexOmniLogo";
import { Plug } from "lucide-react";

export function AssignExchangeDialog({
  open,
  onOpenChange,
  currentExchangeId,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currentExchangeId: string | null;
  onConfirm: (exchangeConnectionId: string | null) => Promise<void> | void;
}) {
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(currentExchangeId);
  const [pending, setPending] = useState(false);

  const { data: conns = [] } = useQuery({
    queryKey: ["exchange-connections-assignable", user?.id],
    enabled: !!user && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, status")
        .eq("user_id", user!.id)
        .neq("status", "disconnected");
      if (error) throw error;
      return (data ?? []) as { id: string; exchange: string; status: string | null }[];
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!pending) onOpenChange(v);
        if (v) setSelected(currentExchangeId);
      }}
    >
      <DialogContent className="mx-auto max-w-sm">
        <DialogHeader>
          <DialogTitle>Assign to exchange</DialogTitle>
          <DialogDescription>
            Pick which exchange connection uses this wallet, or unassign it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <OptionRow
            active={selected === null}
            onSelect={() => setSelected(null)}
            title="No exchange"
            subtitle="Wallet is not linked to any exchange."
            icon={<Plug className="h-4 w-4 text-muted-foreground" />}
          />
          {conns.map((c) => {
            const isApex = c.exchange.toLowerCase().startsWith("apex");
            return (
              <OptionRow
                key={c.id}
                active={selected === c.id}
                onSelect={() => setSelected(c.id)}
                title={venueLabel(c.exchange)}
                subtitle={c.status ?? "unknown"}
                icon={isApex ? <ApexOmniLogo size="sm" /> : <Plug className="h-4 w-4 text-muted-foreground" />}
              />
            );
          })}
          {conns.length === 0 && (
            <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 text-[11.5px] text-muted-foreground">
              No exchange connections yet.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              setPending(true);
              try {
                await onConfirm(selected);
                onOpenChange(false);
              } finally {
                setPending(false);
              }
            }}
            disabled={pending}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptionRow({
  active,
  onSelect,
  title,
  subtitle,
  icon,
}: {
  active: boolean;
  onSelect: () => void;
  title: React.ReactNode;
  subtitle: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
        active
          ? "border-primary/40 bg-primary/10"
          : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
      }`}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold">{title}</div>
        <div className="text-[11px] text-muted-foreground">{subtitle}</div>
      </div>
      <span
        className={`h-3.5 w-3.5 rounded-full border ${active ? "border-primary bg-primary" : "border-white/20"}`}
      />
    </button>
  );
}
