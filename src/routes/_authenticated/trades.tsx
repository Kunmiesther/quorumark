import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/trades")({
  beforeLoad: () => {
    throw redirect({ to: "/trade", hash: "activity" });
  },
});
