import { createFileRoute } from "@tanstack/react-router";
import { StrategyExchangeApp } from "@/components/exchange/StrategyExchangeApp";
export const Route = createFileRoute("/studio")({ component: () => <StrategyExchangeApp view="studio" /> });
