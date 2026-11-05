import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy alias — pricing/plans content now lives at /pricing. */
export const Route = createFileRoute("/_authenticated/profile/subscription")({
  beforeLoad: () => {
    throw redirect({ to: "/pricing" });
  },
});
