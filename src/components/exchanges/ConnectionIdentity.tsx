import { Plug, Wallet } from "lucide-react";
import { venueLabel, venueLogo } from "@/lib/venue-logos";
import { walletLabel, walletLogo } from "@/lib/wallet-logos";

export type WalletIdentityRecord = {
  id: string;
  provider: string;
  label: string | null;
  public_address: string;
  status: string;
  is_active?: boolean;
};

function shortAddress(address: string) {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function ExchangeIdentity({
  exchange,
  name,
  connectionId,
}: {
  exchange: string;
  name?: string | null;
  connectionId?: string | null;
}) {
  const logo = venueLogo(exchange);
  const label = venueLabel(exchange);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2 text-xs">
      {logo ? (
        <img
          src={logo}
          alt=""
          width={22}
          height={22}
          className="h-[22px] w-[22px] shrink-0 rounded-full object-contain"
        />
      ) : (
        <Plug aria-hidden="true" className="h-5 w-5 shrink-0 text-white/50" />
      )}
      <span className="min-w-0 break-words">
        <span className="block font-medium text-white/90">
          {label || "Exchange unavailable"}
          {name && name !== label && name !== exchange ? ` · ${name}` : ""}
        </span>
        <span
          className="block font-mono text-[10px] text-white/50"
          title={connectionId ?? undefined}
        >
          {connectionId ? `Account ${connectionId.slice(0, 8)}…` : "Connection unverified"}
        </span>
      </span>
    </span>
  );
}

export function WalletIdentity({
  wallet,
  emptyLabel = "No wallet assigned",
}: {
  wallet?: WalletIdentityRecord | null;
  emptyLabel?: string;
}) {
  const logo = wallet ? walletLogo(wallet.provider) : undefined;
  const provider = wallet ? walletLabel(wallet.provider) : "";
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2 text-xs">
      {logo ? (
        <img src={logo} alt="" width={20} height={20} className="h-5 w-5 shrink-0 rounded-full object-contain" />
      ) : (
        <Wallet aria-hidden="true" className="h-5 w-5 shrink-0 text-white/45" />
      )}
      <span className="min-w-0 break-words text-white/65">
        {wallet ? (
          <>
            <span className="block">
              {provider || "Wallet"}
              {wallet.label && wallet.label !== provider ? ` · ${wallet.label}` : ""}
            </span>
            <span className="block font-mono text-[10px]" title={wallet.public_address}>
              {shortAddress(wallet.public_address)} ·{" "}
              {wallet.is_active === false ? "inactive" : wallet.status}
            </span>
          </>
        ) : (
          emptyLabel
        )}
      </span>
    </span>
  );
}
