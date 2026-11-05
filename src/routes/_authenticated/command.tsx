import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/command")({
  beforeLoad: () => {
    throw redirect({ to: "/home" });
  },
});
