import ownership from "../../../shared/turtle_strategy_ownership.json";

/** A strategy supplies the setup; an approved Turtle owns its execution. */
export function resolveStrategyTurtle(strategy: string, enabled?: readonly string[]): string | null {
  const candidates = (ownership as Record<string, string[]>)[strategy] ?? [];
  if (enabled === undefined) return candidates[0] ?? null;
  return candidates.find((turtle) => enabled.includes(turtle)) ?? null;
}
