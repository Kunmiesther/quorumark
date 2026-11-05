import { createFileRoute } from "@tanstack/react-router";
import { StrategyExchangeApp } from "@/components/exchange/StrategyExchangeApp";
export const Route = createFileRoute("/marketplace")({ component: () => <StrategyExchangeApp view="marketplace" />, head: () => ({ meta: [{ title: "Marketplace · Quorumark" }, { name: "description", content: "Discover paper verified autonomous trading strategies." }] }) });
