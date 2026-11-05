import { useState } from "react";
import {
  MoreVertical,
  Star,
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  Wallet as WalletIcon,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  Plug,
  PlugZap,
  Trash2,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { walletLogo, walletLabel } from "@/lib/wallet-logos";
import type { WalletWithBalance, WalletHealth } from "@/hooks/useWalletList";

function shortAddr(a: string) {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const HEALTH: Record<WalletHealth, { label: string; cls: string; dot: string }> = {
  connected: {
    label: "Connected",
    cls: "border-positive/25 bg-positive/10 text-positive",
    dot: "bg-positive",
  },
  syncing: {
    label: "Syncing",
    cls: "border-gold/25 bg-gold/10 text-gold",
    dot: "bg-gold animate-pulse",
  },
  network_mismatch: {
    label: "Network",
    cls: "border-gold/30 bg-gold/10 text-gold",
    dot: "bg-gold",
  },
  auth_required: {
    label: "Auth",
    cls: "border-primary/25 bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  disconnected: {
    label: "Offline",
    cls: "border-white/10 bg-white/[0.04] text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
  error: {
    label: "Error",
    cls: "border-negative/30 bg-negative/10 text-negative",
    dot: "bg-negative",
  },
};

const APEX_DEPOSIT_URL = "https://omni.apex.exchange/portfolio";

export interface WalletCardActions {
  onSetDefault: (id: string) => void;
  onRename: (id: string, currentLabel: string | null) => void;
  onToggleApex: (id: string, next: boolean, force?: boolean) => void;
  onAssignExchange: (id: string) => void;
  onReconnect: (id: string, provider: string) => void;
  onDisconnect: (id: string, provider: string, force?: boolean) => void;
  onRemove: (id: string, force?: boolean) => void;
  onRefresh: () => void;
}

export function WalletCard({
  item,
  actions,
}: {
  item: WalletWithBalance;
  actions: WalletCardActions;
}) {
  const { row, usdTotal, health, balanceLoading, balanceError } = item;
  const [hidden, setHidden] = useState(false);
  const label = row.label ?? walletLabel(row.provider);
  const logo = walletLogo(row.provider);
  const h = HEALTH[health];

  const fmtUsd = (n: number) =>
    hidden
      ? "••••"
      : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  async function copyAddr() {
    try {
      await navigator.clipboard.writeText(row.public_address);
      toast.success("Address copied");
    } catch {
      toast.error("Could not copy");
    }
  }

  return (
    <article className="min-w-0 overflow-hidden rounded-2xl bg-white/[0.04] p-4 transition hover:bg-white/[0.06]">
      <header className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)_28px] items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black/40">
          {logo ? (
            <img
              src={logo}
              alt=""
              className="h-8 w-8 rounded-full object-contain"
              loading="lazy"
              width={32}
              height={32}
            />
          ) : (
            <WalletIcon className="h-5 w-5 text-white/50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="max-w-full truncate whitespace-nowrap text-[14px] font-semibold text-white">
              {label}
            </h3>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-semibold ${h.cls}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${h.dot}`} />
              {h.label}
            </span>
            {row.is_default && (
              <span className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-widest text-primary">
                <Star className="h-2.5 w-2.5" strokeWidth={3} /> Default
              </span>
            )}
            {row.apex_authorized && (
              <span className="inline-flex items-center gap-1 rounded-md bg-gold/15 px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-widest text-gold">
                <ShieldCheck className="h-2.5 w-2.5" strokeWidth={3} /> Funding
              </span>
            )}
          </div>
          <p className="mt-1 truncate whitespace-nowrap text-[10.5px] text-white/50">
            {walletLabel(row.provider)} · {row.chain} · {row.network}
          </p>
          <button
            type="button"
            onClick={copyAddr}
            className="mt-0.5 inline-flex max-w-full items-center gap-1 overflow-hidden font-mono text-[10.5px] text-white/50 hover:text-white"
            aria-label="Copy address"
          >
            <span className="truncate whitespace-nowrap">{shortAddr(row.public_address)}</span>
            <Copy className="h-3 w-3 shrink-0" />
          </button>
        </div>
        <div className="flex shrink-0 items-start">
          <WalletMenu row={row} actions={actions} />
        </div>
      </header>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className="num font-display text-[16px] font-semibold leading-none text-white">
            {fmtUsd(usdTotal)}
          </span>
          {balanceLoading && <RefreshCw className="h-3 w-3 animate-spin text-white/40" />}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setHidden((v) => !v);
            }}
            className="flex h-6 w-6 items-center justify-center rounded-full text-white/50 hover:text-white"
            aria-label={hidden ? "Show balance" : "Hide balance"}
          >
            {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.onRefresh();
            }}
            className="flex h-6 w-6 items-center justify-center rounded-full text-white/50 hover:text-white"
            aria-label="Refresh balance"
          >
            <RefreshCw className={`h-3 w-3 ${balanceLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {balanceError && (
        <div className="mt-2 flex items-start gap-2 rounded-xl bg-red-500/[0.08] p-2 text-[11px] text-red-200">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0">{balanceError}</span>
        </div>
      )}
    </article>
  );
}

function WalletMenu({
  row,
  actions,
}: {
  row: WalletWithBalance["row"];
  actions: WalletCardActions;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="flex h-7 w-7 items-center justify-center rounded-full text-white/50 transition hover:bg-white/[0.06] hover:text-white"
          aria-label="More actions"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {row.label ?? walletLabel(row.provider)}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!row.is_default && (
          <DropdownMenuItem onClick={() => actions.onSetDefault(row.id)}>
            <Star className="mr-2 h-3.5 w-3.5" /> Set as default
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => actions.onRename(row.id, row.label)}>
          Rename…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => actions.onAssignExchange(row.id)}>
          <Plug className="mr-2 h-3.5 w-3.5" /> Assign to exchange…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => actions.onToggleApex(row.id, !row.apex_authorized)}>
          <ShieldCheck className="mr-2 h-3.5 w-3.5" />
          {row.apex_authorized ? "Remove as ApeX funding wallet" : "Use as ApeX funding wallet"}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={APEX_DEPOSIT_URL} target="_blank" rel="noreferrer noopener">
            <ArrowUpRight className="mr-2 h-3.5 w-3.5" /> Open ApeX deposit
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => actions.onReconnect(row.id, row.provider)}>
          <PlugZap className="mr-2 h-3.5 w-3.5" /> Reconnect
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => actions.onDisconnect(row.id, row.provider)}
          className="text-negative focus:text-negative"
        >
          <Plug className="mr-2 h-3.5 w-3.5 rotate-180" /> Disconnect
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => actions.onRemove(row.id)}
          className="text-negative focus:text-negative"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" /> Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WalletCardSkeleton() {
  return (
    <div className="rounded-2xl bg-white/[0.04] p-4">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 shrink-0 animate-pulse rounded-xl bg-white/[0.06]" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3 w-32 animate-pulse rounded bg-white/[0.06]" />
          <div className="h-2.5 w-48 animate-pulse rounded bg-white/[0.04]" />
        </div>
      </div>
    </div>
  );
}

export function WalletCardLoadingIndicator() {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Loading wallets…
    </div>
  );
}
