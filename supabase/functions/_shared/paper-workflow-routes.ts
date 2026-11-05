/** Paper routing is owned by the approved workflow, never by a live execution row. */
export function isIndependentPaperPlan(proposal: unknown): boolean {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return false;
  const value = proposal as Record<string, unknown>;
  return value.setupBook === "paper" && value.paperRouteVersion === 1;
}

export function paperWorkflowRoutes(plan: {
  id: string;
  proposal: unknown;
  enabled_turtles?: unknown;
}) {
  if (!isIndependentPaperPlan(plan.proposal)) return [];
  const proposal = plan.proposal as Record<string, unknown>;
  const assignments = proposal.venueAssignments;
  const turtles = plan.enabled_turtles;
  if (
    !Array.isArray(assignments) ||
    !assignments.length ||
    !Array.isArray(turtles) ||
    !turtles.length ||
    !turtles.every((t) => typeof t === "string")
  )
    return [];
  const routes: Array<{
    workflowId: string;
    connectionId: string;
    symbol: string;
    turtles: string[];
  }> = [];
  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return [];
    const { connectionId, symbol } = assignment as Record<string, unknown>;
    if (typeof connectionId !== "string" || !connectionId || typeof symbol !== "string" || !symbol)
      return [];
    routes.push({ workflowId: plan.id, connectionId, symbol, turtles: [...turtles] });
  }
  return routes;
}
