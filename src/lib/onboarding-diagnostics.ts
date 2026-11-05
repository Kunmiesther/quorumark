import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";

export type OnboardingDiagnosticEntry = {
  id: string;
  at: string;
  route: string;
  source: string;
  status: string;
  detail?: string;
};

const STORE_KEY = "tb_onboarding_diagnostics";
const EVENT_NAME = "tb:onboarding-diagnostics";
const MAX_ENTRIES = 18;

function getStoredEntries(): OnboardingDiagnosticEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function readOnboardingDiagnostics() {
  return getStoredEntries();
}

export function recordOnboardingDiagnostic(entry: Omit<OnboardingDiagnosticEntry, "id" | "at">) {
  if (typeof window === "undefined") return;

  const nextEntry: OnboardingDiagnosticEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    at: new Date().toLocaleTimeString(),
  };

  const nextEntries = [nextEntry, ...getStoredEntries()].slice(0, MAX_ENTRIES);
  window.sessionStorage.setItem(STORE_KEY, JSON.stringify(nextEntries));
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: nextEntries }));
}

export function subscribeToOnboardingDiagnostics(listener: (entries: OnboardingDiagnosticEntry[]) => void) {
  if (typeof window === "undefined") return () => undefined;

  const handler = (event: Event) => {
    const entries = event instanceof CustomEvent && Array.isArray(event.detail) ? event.detail : getStoredEntries();
    listener(entries);
  };

  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

export function useOnboardingRouteDiagnostics({
  source,
  loading,
  userId,
  requiresAuth = true,
}: {
  source: string;
  loading: boolean;
  userId?: string | null;
  requiresAuth?: boolean;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    recordOnboardingDiagnostic({
      route: pathname,
      source,
      status: "route mounted",
    });
  }, [pathname, source]);

  useEffect(() => {
    if (loading) {
      recordOnboardingDiagnostic({
        route: pathname,
        source: `${source} auth guard`,
        status: "waiting for session",
      });
      return;
    }

    if (requiresAuth && !userId) {
      recordOnboardingDiagnostic({
        route: pathname,
        source: `${source} auth guard`,
        status: "redirecting",
        detail: "No signed-in user; sending to /welcome",
      });
      return;
    }

    recordOnboardingDiagnostic({
      route: pathname,
      source: `${source} auth guard`,
      status: requiresAuth ? "allowed" : userId ? "signed in" : "public",
      detail: userId ? `User ${userId.slice(0, 8)}…` : "No active user",
    });
  }, [loading, pathname, requiresAuth, source, userId]);
}