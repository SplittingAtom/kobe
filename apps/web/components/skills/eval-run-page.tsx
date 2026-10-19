"use client";

import Link from "next/link";
import { getEvalRun, subjectLabel } from "../../lib/skills/evals-api";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { useTeamAccess } from "../admin/console-context";
import { Notice, PageHeader } from "../ui/console";
import { EvalScorecard } from "./eval-scorecard";

/** One eval's full scorecard (KOBE-328): opened from a version's eval history. */
export function EvalRunPage({ evalRunId }: { readonly evalRunId: string }) {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => getEvalRun(teamId, evalRunId));
  return (
    <ResourceView state={state} label="eval">
      {(run) => (
        <>
          <PageHeader
            title={`Eval of ${subjectLabel(run)}`}
            back={<Link href="/me/skills">Skills</Link>}
            description={`${run.mode === "full" ? "With a no-skill baseline" : "With the skill only"} · started ${new Date(run.startedAt).toLocaleString()}`}
          />
          {run.scorecard ? (
            <EvalScorecard card={run.scorecard} />
          ) : run.status === "queued" || run.status === "running" ? (
            <p role="status">
              {run.progress.done} of {run.progress.total} runs done…
            </p>
          ) : (
            <Notice tone={run.status === "cancelled" ? "info" : "error"}>
              <p>{run.failure?.message ?? `This eval ended ${run.status.replace("_", " ")}.`}</p>
            </Notice>
          )}
        </>
      )}
    </ResourceView>
  );
}
