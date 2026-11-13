import { createFileRoute, Outlet } from "@tanstack/react-router";
import { StrategyExchangeApp } from "@/components/exchange/StrategyExchangeApp";
export const Route = createFileRoute("/marketplace")({
  component: Outlet,
  head: () => ({
    meta: [
      { title: "Marketplace · Quorumark" },
      { name: "description", content: "Discover paper-verified autonomous trading strategies." },
    ],
  }),
});
