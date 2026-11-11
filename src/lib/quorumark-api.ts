import { PUBLIC_PYTHON_BACKEND_URL } from "@/lib/public-env";

export const WALLET_SESSION_KEY = "quorumark.wallet.session";
export type WalletSession = { address: string; chain: string; verified: boolean; token?: string; expiresAt?: string };

export function getStoredWalletSession(): WalletSession | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(WALLET_SESSION_KEY) ?? "null",
    ) as WalletSession | null;
    return value?.address ? value : null;
  } catch {
    return null;
  }
}

export function isWalletSessionExpired(session: WalletSession | null = getStoredWalletSession()): boolean {
  if (!session?.expiresAt) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

export function getWalletSession(): WalletSession | null {
  const session = getStoredWalletSession();
  return session?.verified && !isWalletSessionExpired(session) ? session : null;
}

export function expireWalletSession() {
  const session = getStoredWalletSession();
  if (!session || typeof window === "undefined") return;
  window.sessionStorage.setItem(WALLET_SESSION_KEY, JSON.stringify({ ...session, verified: false, token: undefined }));
  window.dispatchEvent(new Event("quorumark-wallet-session"));
}

export function saveWalletSession(session: WalletSession) {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(WALLET_SESSION_KEY, JSON.stringify(session));
    window.dispatchEvent(new Event("quorumark-wallet-session"));
  }
}

export function clearWalletSession() {
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(WALLET_SESSION_KEY);
    window.dispatchEvent(new Event("quorumark-wallet-session"));
  }
}

export async function quorumarkApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!PUBLIC_PYTHON_BACKEND_URL) throw new Error("The strategy service is not configured. Please try again later.");
  const session = getWalletSession();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (session?.token) headers.set("authorization", `Bearer ${session.token}`);
  let response: Response;
  try {
    response = await fetch(`${PUBLIC_PYTHON_BACKEND_URL.replace(/\/$/, "")}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new Error("We couldn't connect to the strategy service. Check your connection and try again.");
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    const hadVerifiedSession = Boolean(session?.verified || getStoredWalletSession()?.token);
    expireWalletSession();
    throw new Error(hadVerifiedSession ? "Your sign-in has expired. Verify your wallet again to continue." : "Verify your wallet to continue.");
  }
  if (!response.ok) throw new Error(body?.detail ?? "We couldn't complete that request. Please try again.");
  return body as T;
}
