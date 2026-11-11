import { Check, WalletCards, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { clearWalletSession, getStoredWalletSession, getWalletSession, type WalletSession } from "@/lib/quorumark-api";

function shortAddress(address: string) {
  return address.length > 16 ? `${address.slice(0, 7)}…${address.slice(-8)}` : address;
}

export function WalletAccountMenu({ className = "" }: { className?: string }) {
  const [session, setSession] = useState<WalletSession | null>(() => getStoredWalletSession());
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      const next = getStoredWalletSession();
      setSession(next);
      if (!next) setOpen(false);
    };
    window.addEventListener("quorumark-wallet-session", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("quorumark-wallet-session", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function copyAddress() {
    if (!session) return;
    await navigator.clipboard.writeText(session.address);
    setCopied(true);
    toast.success("Wallet address copied");
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function disconnect() {
    if (session?.chain === "near:testnet") {
      try {
        const { signOutNear } = await import("@/lib/wallet/near");
        await signOutNear();
      } catch {
        // Clearing the application session is still safe if the wallet is unavailable.
      }
    }
    clearWalletSession();
    toast.success("Wallet disconnected");
  }

  if (!session) {
    return <Link to="/connect-wallet" className={`q-wallet-button ${className}`}><WalletCards size={16} /> Connect wallet</Link>;
  }

  const verified = Boolean(getWalletSession());
  return (
    <div className={`q-wallet-account ${className}`} ref={rootRef}>
      <button className="q-wallet-button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu">
        <WalletCards size={16} /> {shortAddress(session.address)}
      </button>
      {open && <div className="q-wallet-menu" role="menu">
        <div className="q-wallet-menu-head"><span>Connected wallet</span><button className="q-icon-button" onClick={() => setOpen(false)} aria-label="Close wallet menu"><X size={15} /></button></div>
        <strong className="q-wallet-full-address">{session.address}</strong>
        <span className="q-wallet-session-status"><i /> {verified ? "Verified session" : "Verification expired"}</span>
        <button className="q-wallet-menu-action" onClick={copyAddress} role="menuitem"><Check size={15} /> {copied ? "Copied" : "Copy wallet address"}</button>
        {!verified && <Link to="/connect-wallet" className="q-wallet-menu-action" role="menuitem" onClick={() => setOpen(false)}>Verify wallet again</Link>}
        <button className="q-wallet-menu-action q-wallet-signout" onClick={disconnect} role="menuitem"><WalletCards size={15} /> Disconnect</button>
      </div>}
    </div>
  );
}
