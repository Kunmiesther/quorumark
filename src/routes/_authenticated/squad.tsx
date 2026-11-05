import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/squad")({
  beforeLoad: () => {
    throw redirect({ to: "/strategies" });
  },
});
