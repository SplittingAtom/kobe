"use client";

import Link from "next/link";
import type { EventSourceFactory } from "../../lib/chat/stream";
import { isOpen } from "../../lib/skills/eval-format";
import { getEvalRun } from "../../lib/skills/evals-api";
import { useLiveEval } from "../../lib/skills/use-live-eval";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { useTeamAccess } from "../admin/console-context";
import { PageHeader } from "../ui/console";
import { ShownRun } from "./evals-panel";

/** One eval's full scorecard (KOBE-328), live while it runs: opened from an eval history. */
export function EvalRunPage({
  evalRunId,
  eventSource,
}: {
  readonly evalRunId: string;
  readonly eventSource?: EventSourceFactory;
}) {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getEvalRun(teamId, evalRunId));
  const open = state.status === "ready" && isOpen(state.data.status) ? [evalRunId] : [];
  useLiveEval(
    open,
    async () => {
      reload();
      return true;
    },
    eventSource,
  );
  return (
    <ResourceView state={state} label="eval">
      {(run) => (
        <>
          <PageHeader
            title="Eval"
            back={<Link href="/me/skills">Skills</Link>}
            description={`Started ${new Date(run.startedAt).toLocaleString()}`}
          />
          <ShownRun run={run} />
        </>
      )}
    </ResourceView>
  );
}
