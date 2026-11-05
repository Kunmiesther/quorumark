import { useMemo, useState, useEffect } from "react";
import { RefreshCw, Wallet as WalletIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import {
  listProviders,
  connectProvider,
  signChallenge,
  subscribeProviders,
  WalletError,
  type WalletProviderId,
} from "@/lib/wallet/providers";

const PROVIDER_LABEL: Record<string, string> = {
  phantom: "Phantom",
  metamask: "MetaMask",
  coinbase: "Coinbase Wallet",
  bitget: "Bitget Wallet",
  trust: "Trust Wallet",
  rainbow: "Rainbow",
  walletconnect: "WalletConnect",
};

const ORDER: WalletProviderId[] = [
  "phantom",
  "coinbase",
  "bitget",
  "metamask",
  "trust",
  "rainbow",
  "walletconnect",
];

export function AddWalletModal({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const [, force] = useState(0);
  useEffect(() => subscribeProviders(() => force((n) => n + 1)), []);
  const [connectingId, setConnectingId] = useState<WalletProviderId | null>(null);
  const [phase, setPhase] = useState<"idle" | "connecting" | "awaiting_signature" | "verifying">(
    "idle",
  );

  const providers = useMemo(() => {
    const list = listProviders();
    const byId = new Map(list.map((p) => [p.id, p]));
    return ORDER.map((id) => byId.get(id)).filter(Boolean) as ReturnType<typeof listProviders>;
  }, [connectingId]);

  async function handleConnect(id: WalletProviderId) {
    setConnectingId(id);
    setPhase("connecting");
    try {
      const conn = await connectProvider(id);
      const chalRes = await supabase.functions.invoke("wallet-challenge", {
        body: { provider: conn.provider, chain: conn.chain, public_address: conn.publicAddress },
      });
      const chalPayload = chalRes.data as
        | { ok?: boolean; message?: string; challenge_text?: string; nonce_hash?: string }
        | null;
      if (
        chalRes.error ||
        !chalPayload?.ok ||
        !chalPayload.challenge_text ||
        !chalPayload.nonce_hash
      ) {
        throw new WalletError(
          "CHALLENGE_FAILED",
          chalPayload?.message ?? "Could not start verification.",
        );
      }
      setPhase("awaiting_signature");
      const signed = await signChallenge(
        conn.provider,
        conn.publicAddress,
        chalPayload.challenge_text,
      );
      setPhase("verifying");
      const verifyRes = await supabase.functions.invoke("wallet-verify", {
        body: {
          provider: conn.provider,
          chain: conn.chain,
          public_address: conn.publicAddress,
          signature: signed.signature,
          nonce_hash: chalPayload.nonce_hash,
        },
      });
      const verifyPayload = verifyRes.data as
        | { ok?: boolean; message?: string; code?: string }
        | null;
      if (verifyRes.error || !verifyPayload?.ok) {
        throw new WalletError(
          verifyPayload?.code ?? "VERIFY_FAILED",
          verifyPayload?.message ?? "Verification failed.",
        );
      }
      toast.success(`${PROVIDER_LABEL[conn.provider]} added`);
      onAdded();
      onOpenChange(false);
    } catch (e) {
      const err =
        e instanceof WalletError
          ? e
          : new WalletError(
              "UNKNOWN_ERROR",
              e instanceof Error ? e.message : "Something went wrong.",
            );
      toast.error(walletErrorMessage(err));
    } finally {
      setConnectingId(null);
      setPhase("idle");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="mx-auto max-w-md gap-0 border border-white/10 bg-[#0F1118] p-0">
        <DialogHeader className="border-b border-white/[0.06] px-5 py-4">
          <DialogTitle className="text-[15px] font-semibold">Add another wallet</DialogTitle>
          <DialogDescription className="text-[11.5px] text-muted-foreground">
            Sign a one-time message to prove ownership. No transfers or transactions.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          <div className="space-y-2">
            {providers.map((p) => {
              const isConfigMissing = p.status === "needs_configuration";
              const isComingSoon = p.status === "coming_soon";
              const badge =
                p.status === "available"
                  ? null
                  : p.status === "not_installed"
                    ? "Not installed"
                    : isConfigMissing
                      ? "Needs configuration"
                      : "Coming soon";
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    if (isComingSoon) return;
                    if (isConfigMissing) {
                      toast.error(
                        p.id === "walletconnect"
                          ? "WalletConnect project ID is not configured."
                          : "This wallet needs configuration.",
                      );
                      return;
                    }
                    if (p.status === "not_installed" && p.installUrl) {
                      window.open(p.installUrl, "_blank", "noopener,noreferrer");
                      return;
                    }
                    if (p.status === "available") handleConnect(p.id);
                  }}
                  disabled={connectingId !== null && connectingId !== p.id}
                  className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-left transition active:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <WalletIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold">{p.name}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {p.chain === "solana" ? "Solana" : "EVM"}
                    </p>
                  </div>
                  {badge ? (
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {badge}
                    </span>
                  ) : connectingId === p.id ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-primary" />
                  ) : (
                    <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      Connect
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {connectingId && phase !== "idle" && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/10 px-3 py-2 text-[11.5px] font-medium text-primary">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {phase === "connecting" && "Connecting to wallet…"}
              {phase === "awaiting_signature" && "Awaiting signature in wallet…"}
              {phase === "verifying" && "Verifying signature…"}
            </div>
          )}

          <p className="mt-4 text-[10.5px] text-muted-foreground">
            Duplicate addresses on the same chain and provider are not added twice.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function walletErrorMessage(e: WalletError): string {
  switch (e.code) {
    case "EXTENSION_NOT_INSTALLED":
      return e.message;
    case "USER_REJECTED_CONNECT":
      return "You rejected the connection request.";
    case "USER_REJECTED_SIGN":
      return "You rejected the signature request.";
    case "ADDRESS_CHANGED":
      return "Wallet account changed. Reconnect and try again.";
    case "PROVIDER_UNAVAILABLE":
      return e.message;
    case "CHALLENGE_EXPIRED":
      return "Signing challenge expired. Try again.";
    case "CHALLENGE_ALREADY_USED":
      return "This challenge was already used.";
    case "INVALID_SIGNATURE":
      return "Signature did not verify against the wallet.";
    case "PROVIDER_MISMATCH":
    case "CHAIN_MISMATCH":
      return "Wallet details changed. Try again.";
    case "WALLETCONNECT_SESSION_EXPIRED":
      return "WalletConnect session expired.";
    default:
      return e.message || "Could not connect wallet.";
  }
}
