import type { QueryClient } from "@tanstack/react-query";

// SIGNED_IN also fires when an existing session is confirmed after tab focus.
export function createAuthCacheHandler(queryClient: QueryClient, router: { invalidate: () => unknown }) {
  let currentUserId: string | null | undefined;
  return (event: string, userId: string | null) => {
    if (event === "INITIAL_SESSION") {
      currentUserId = userId;
      return;
    }
    const identityChanged = currentUserId !== userId;
    currentUserId = userId;
    if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED" && !identityChanged) return;
    if (event === "SIGNED_OUT" || identityChanged) {
      void queryClient.cancelQueries();
      queryClient.clear();
    }
    // Same-user session confirmation must not remount in-progress wallet flows.
    if (event === "SIGNED_IN" && !identityChanged) return;
    void router.invalidate();
    if (event !== "SIGNED_OUT") void queryClient.invalidateQueries({ refetchType: "active" });
  };
}
