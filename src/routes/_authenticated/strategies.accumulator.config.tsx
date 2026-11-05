import { createFileRoute } from "@tanstack/react-router";
import { AccumulatorPage } from "@/components/turtle/AccumulatorSquadPage";

export const Route = createFileRoute("/_authenticated/strategies/accumulator/config")({
  head: () => ({
    meta: [
      { title: "Arbiter — Advanced Configuration" },
      { name: "description", content: "Configure the Arbiter strategy: budget floor, safety orders, target ladder." },
    ],
  }),
  component: AccumulatorPage,
});
