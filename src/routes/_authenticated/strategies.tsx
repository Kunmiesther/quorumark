import { createFileRoute, redirect } from "@tanstack/react-router";

/** Strategy selection now lives in the Dashboard automation section. */
export const Route = createFileRoute("/_authenticated/strategies")({
  beforeLoad: () => {
    throw redirect({ to: "/home", hash: "automation" });
  },
});
