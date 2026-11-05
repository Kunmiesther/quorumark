import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/wallet")({
  beforeLoad: () => {
    throw redirect({ to: "/exchanges", hash: "wallets" });
  },
});
