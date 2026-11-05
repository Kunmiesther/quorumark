import { createFileRoute } from "@tanstack/react-router";
import { StrategyExchangeApp } from "@/components/exchange/StrategyExchangeApp";
export const Route = createFileRoute("/subscriptions")({ component: () => <StrategyExchangeApp view="subscriptions" /> });
