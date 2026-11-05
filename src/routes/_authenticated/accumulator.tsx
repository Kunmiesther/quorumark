import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/accumulator")({
  beforeLoad: () => {
    throw redirect({ to: "/strategies/$slug", params: { slug: "accumulator" }, replace: true });
  },
});
