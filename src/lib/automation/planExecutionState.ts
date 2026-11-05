/** Read-only reconciliation. Never promote a saved plan or resume a paused venue. */
export function planExecutionState(
  planStatus: string,
  rows: ReadonlyArray<{ enabled: boolean; mode: string }>,
  pauseReason?: string | null,
) {
  const armed = rows.filter((row) => row.enabled && row.mode === "live").length;
  const legacyPaperPause =
    planStatus === "paused" && pauseReason === "Automatic loss limit reached" && armed > 0;
  const conflict =
    armed > 0 &&
    ["draft", "awaiting_approval", "paused", "rejected", "archived"].includes(planStatus);
  return {
    armed,
    conflict,
    label: legacyPaperPause
      ? "Live rows armed · plan needs reconciliation"
      : conflict
        ? "Configuration conflict"
        : rows.length === 0
          ? "No execution rows"
          : armed === 0
            ? "Not armed live"
            : armed === rows.length
              ? "Live rows armed"
              : "Partially armed",
    detail: legacyPaperPause
      ? `The saved plan was paused by the legacy paper-loss check, which did not verify plan attribution. ${armed} live execution row${armed === 1 ? " remains" : "s remain"} armed. This is not evidence of a live loss or a stopped exchange; review live controls and venue status below.`
      : conflict
        ? `Saved plan is ${planStatus.replaceAll("_", " ")}, but ${armed} live execution row${armed === 1 ? " is" : "s are"} enabled. Review the live controls; the plan label alone does not stop execution.`
        : `${armed} of ${rows.length} execution rows armed. Arming is configuration, not proof of orders or fills.`,
  };
}
