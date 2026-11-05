import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Onyx is no longer a destination — it is a global panel opened from any
 * page. This route now redirects to /home with a hash the shell reads to
 * open the panel once, then clears.
 */
export const Route = createFileRoute("/_authenticated/orchestrator")({
  beforeLoad: () => {
    throw redirect({ to: "/home", hash: "onyx" });
  },
});
