import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/signals")({
  beforeLoad: () => {
    throw redirect({ to: "/trade", hash: "signals" });
  },
});
