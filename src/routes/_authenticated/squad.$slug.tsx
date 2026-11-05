import { createFileRoute, redirect } from "@tanstack/react-router";
import { turtleByAnyKey } from "@/lib/turtles";

export const Route = createFileRoute("/_authenticated/squad/$slug")({
  beforeLoad: ({ params }) => {
    const t = turtleByAnyKey(params.slug);
    const key = t?.key ?? params.slug;
    throw redirect({ to: "/strategies/$slug", params: { slug: key }, replace: true });
  },
});
