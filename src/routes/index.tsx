import { createFileRoute } from "@tanstack/react-router";
import { StrategyExchangeLanding } from "@/components/landing/StrategyExchangeLanding";

export const Route = createFileRoute("/")({
  component: StrategyExchangeLanding,
  head: () => ({ meta: [
    { title: "Quorumark Strategy Exchange" },
    { name: "description", content: "Discover private autonomous strategies, verify performance, and follow signals with independent risk controls." },
    { property: "og:title", content: "Quorumark Strategy Exchange" },
    { property: "og:description", content: "Your strategy. Your edge. Your rules." },
    { property: "og:type", content: "website" },
  ] }),
});
