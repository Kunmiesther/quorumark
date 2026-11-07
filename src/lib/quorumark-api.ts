import { PUBLIC_PYTHON_BACKEND_URL } from "@/lib/public-env";

export const WALLET_SESSION_KEY = "quorumark.wallet.session";
export type WalletSession = { address: string; chain: string; verified: boolean; token?: string; expiresAt?: string };

export function getWalletSession(): WalletSession | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(WALLET_SESSION_KEY) ?? "null",
    ) as WalletSession | null;
    return value?.verified && value.address ? value : null;
  } catch {
    return null;
  }
}

export function saveWalletSession(session: WalletSession) {
  if (typeof window !== "undefined")
    window.sessionStorage.setItem(WALLET_SESSION_KEY, JSON.stringify(session));
}

export function clearWalletSession() {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(WALLET_SESSION_KEY);
}

export async function quorumarkApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!PUBLIC_PYTHON_BACKEND_URL) throw new Error("The local strategy service is not configured");
  const session = getWalletSession();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (session?.token) headers.set("authorization", `Bearer ${session.token}`);
  const response = await fetch(`${PUBLIC_PYTHON_BACKEND_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    headers,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(body?.detail ?? `Quorumark service returned HTTP ${response.status}`);
  return body as T;
}
