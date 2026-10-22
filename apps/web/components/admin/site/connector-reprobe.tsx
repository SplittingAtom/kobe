"use client";

import {
  reprobeConnector,
  type Connector,
  type ReprobeOutcome,
} from "../../../lib/admin/api/site/connectors";
import { Button } from "../../ui/console";
import type { Mutation } from "../use-resource";

/** New or changed tools are waiting for approval after this outcome. */
export const needsReview = (outcome: ReprobeOutcome): boolean =>
  outcome.status === "drifted" && outcome.changed + outcome.added > 0;

/**
 * Re-probe now (KOBE-430): runs the periodic refresh's probe and drift for one connector. The
 * server's sentence says what happened (unchanged, N changed / added / removed, or why it
 * failed); changed and new tools stay disabled until approved in the review (D27).
 */
export function ReprobeButton({
  connector: c,
  mutation,
  onDone,
}: {
  readonly connector: Connector;
  readonly mutation: Mutation;
  readonly onDone: (connector: Connector, outcome: ReprobeOutcome) => void;
}) {
  if (c.status !== "active") return null;
  async function reprobe() {
    let result: { connector: Connector; outcome: ReprobeOutcome } | undefined;
    const done = await mutation.run(
      () => reprobeConnector(c.id),
      (r) => {
        result = { connector: r.connector, outcome: r.refresh };
        return r.refresh.message;
      },
    );
    if (done && result) onDone(result.connector, result.outcome);
  }
  return (
    <Button size="sm" disabled={mutation.pending} onClick={() => void reprobe()}>
      Re-probe<span className="sr-only"> {c.name}</span>
    </Button>
  );
}
