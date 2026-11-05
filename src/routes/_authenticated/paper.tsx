// Standalone paper dashboard was deleted (owner ruling — UI consolidation).
// The Trade page's paper/live switch is now the ONLY entry point to paper
// mode. Old inbound links (/paper) land on /trade with paper mode active
// so they never 404.
//
// The paper engine, its cron/tick loop, and the shadow-ledger writes all
// keep running exactly as-is — this is a UI-only redirect.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/paper")({
  beforeLoad: () => {
    throw redirect({ to: "/trade", search: { book: "paper" } });
  },
});
