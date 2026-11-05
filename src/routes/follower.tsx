import { createFileRoute } from "@tanstack/react-router";
import { StrategyExchangeApp } from "@/components/exchange/StrategyExchangeApp";
export const Route = createFileRoute("/follower")({ component: () => <StrategyExchangeApp view="follower" /> });
