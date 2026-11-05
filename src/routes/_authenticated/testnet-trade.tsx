import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Testnet is no longer part of the customer experience. This URL is kept
 * so old links / bookmarks resolve — they redirect straight to /trade.
 * Do NOT restore any testnet UI here. The backend testnet functions are
 * fail-closed at HTTP 410.
 */
export const Route = createFileRoute("/_authenticated/testnet-trade")({
  beforeLoad: () => {
    throw redirect({ to: "/trade" });
  },
});
