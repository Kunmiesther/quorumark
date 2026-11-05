import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy alias — subscription/plan content lives at /profile/subscription. */
export const Route = createFileRoute("/_authenticated/plan")({
  beforeLoad: () => {
    throw redirect({ to: "/profile/subscription" });
  },
});
