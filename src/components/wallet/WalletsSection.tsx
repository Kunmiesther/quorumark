import { useState } from "react";
import { toast } from "sonner";
import { Plus, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useWalletList } from "@/hooks/useWalletList";
import { WalletCard, WalletCardSkeleton } from "@/components/wallet/WalletCard";
import { AddWalletModal } from "@/components/wallet/AddWalletModal";

async function manage(action: string, body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("wallet-manage", {
    body: { action, ...body },
  });
  if (error) throw new Error(error.message);
  if (data && (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { message?: string }).message ?? "Action failed");
  }
  return data;
}

export function WalletsSection({ compact = false }: { compact?: boolean } = {}) {
  const wallets = useWalletList();
  const [addOpen, setAddOpen] = useState(false);

  async function withToast(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast.success(label);
      await wallets.refetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-[13px] font-semibold text-white">Connected wallets</h2>
          <p className="text-[11.5px] text-white/55">
            {wallets.walletCount}/20 connected · {wallets.healthyCount} healthy
            {wallets.needAttentionCount > 0
              ? ` · ${wallets.needAttentionCount} need attention`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => wallets.refetchAll()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:bg-white/[0.06] hover:text-white"
            aria-label="Refresh wallets"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${wallets.balancesFetching ? "animate-spin" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            disabled={wallets.walletCount >= 20}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-semibold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            <Plus className="h-3 w-3" />
            Add wallet
          </button>
        </div>
      </header>

      {wallets.isLoading ? (
        <div className={compact ? "grid gap-2.5" : "grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3"}>
          <WalletCardSkeleton />
          <WalletCardSkeleton />
        </div>
      ) : wallets.items.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center">
          <p className="text-[12.5px] text-white/60">No wallets connected yet.</p>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11.5px] font-semibold text-white"
            style={{ background: "var(--accent)" }}
          >
            <Plus className="h-3 w-3" />
            Connect wallet
          </button>
        </div>
      ) : (
        <div className={compact ? "grid gap-2.5" : "grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3"}>
          {wallets.items.map((item) => (
            <WalletCard
              key={item.row.id}
              item={item}
              actions={{
                onSetDefault: (id) =>
                  withToast("Default wallet updated", () =>
                    manage("set_default", { connection_id: id }),
                  ),
                onRename: (id, current) => {
                  const label = window.prompt("Rename wallet", current ?? "");
                  if (label === null) return;
                  void withToast("Wallet renamed", () =>
                    manage("rename", { connection_id: id, label }),
                  );
                },
                onToggleApex: (id, next, force) =>
                  withToast(next ? "Authorized for ApeX" : "ApeX authorization revoked", () =>
                    manage("set_apex_authorized", {
                      connection_id: id,
                      authorized: next,
                      force: force ?? false,
                    }),
                  ),
                onAssignExchange: () =>
                  toast.message("Use Manage API keys to link this wallet to an exchange."),
                onReconnect: () =>
                  toast.message("Reconnect from your wallet extension, then refresh."),
                onDisconnect: (id, _provider, force) =>
                  withToast("Wallet disconnected", () =>
                    manage("disconnect", { connection_id: id, force: force ?? false }),
                  ),
                onRemove: (id, force) => {
                  if (!window.confirm("Remove this wallet from TurtleBot?")) return;
                  void withToast("Wallet removed", () =>
                    manage("remove", { connection_id: id, force: force ?? false }),
                  );
                },
                onRefresh: () => void wallets.refetchAll(),
              }}
            />
          ))}
        </div>
      )}

      <AddWalletModal
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          setAddOpen(false);
          void wallets.refetchAll();
        }}
      />
    </section>
  );
}
