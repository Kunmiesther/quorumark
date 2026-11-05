import { resolveStrategyTurtle } from "./strategyOwnership";
export type PaperPlanRoute = {
  workflowId: string;
  connectionId: string;
  symbol: string;
  turtles: string[];
};
/** Legacy default owner, for callers without a selected mandate. */
export function paperTurtleForStrategy(strategy: string): string {
  return resolveStrategyTurtle(strategy) ?? strategy;
}
export function authorizePaperCandidate(
  controlled: boolean,
  routes: PaperPlanRoute[],
  symbol: string,
  strategy: string,
) {
  if (!controlled) return {
    allowed: true, route: null, executingTurtle: null, reason: "legacy",
  } as const;
  const matches = routes
    .filter((route) => route.symbol === symbol)
    .map((route) => ({ route, executingTurtle: resolveStrategyTurtle(strategy, route.turtles) }))
    .filter((match) => match.executingTurtle !== null);
  if (matches.length !== 1)
    return {
      allowed: false, route: null, executingTurtle: null,
      reason: matches.length ? "ambiguous_plan_route" : "no_active_paper_plan_route",
    } as const;
  return { allowed: true, ...matches[0], reason: "authorized_plan" } as const;
}
