import {
  isTerminalRunStatus,
  type RunTransition,
  type RunTransitionListener,
} from "@kobe/protocol";

/**
 * The seam for what happens when a scheduled run ends (KOBE-174): KOBE-178 (deny-don't-wait
 * report) and KOBE-179 (notifications) subscribe here instead of touching the scheduler. The
 * listener is called once per terminal transition of a `trigger=schedule` run, on the process
 * that applied it (a server replica for runs the wire ends, the scheduler for a budget-blocked
 * run that failed at fire time). It must not throw or block; do durable work in your own
 * transaction, idempotently (unique per run, e.g. `notifications_run_kind_uniq`).
 */
export function onScheduledRunEnded(
  runs: { onTransition(listener: RunTransitionListener): () => void },
  listener: (transition: RunTransition) => void,
): () => void {
  return runs.onTransition((transition) => {
    if (transition.run.trigger !== "schedule" || !isTerminalRunStatus(transition.to)) return;
    listener(transition);
  });
}
