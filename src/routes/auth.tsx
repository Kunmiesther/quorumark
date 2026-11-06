import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy inbound links resolve to the wallet first authentication surface. */
export const Route = createFileRoute("/auth")({ beforeLoad: () => { throw redirect({ to: "/connect-wallet" }); } });
