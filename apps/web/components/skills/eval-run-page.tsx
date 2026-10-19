"use client";

import Link from "next/link";
import type { EventSourceFactory } from "../../lib/chat/stream";
import { isOpen } from "../../lib/skills/eval-format";
import { useState } from "react";
import { getEvalRun, type SkillEvalRun } from "../../lib/skills/evals-api";
import { STALLED_MESSAGE, useLiveEval } from "../../lib/skills/use-live-eval";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { useTeamAccess } from "../admin/console-context";
import { Notice, PageHeader } from "../ui/console";
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
  const { state } = useResource(() => getEvalRun(teamId, evalRunId));
  // Live reads replace the first one; a failed read counts toward the stall.
  const [live, setLive] = useState<SkillEvalRun | null>(null);
  const current = live ?? (state.status === "ready" ? state.data : null);
  const open = current && isOpen(current.status) ? [evalRunId] : [];
  const { stalled } = useLiveEval(
    open,
    async () => {
      const res = await getEvalRun(teamId, evalRunId);
      if (res.ok) setLive(res.data);
      return res.ok;
    },
    eventSource,
  );
  return (
    <ResourceView state={state} label="eval">
      {(first) => (
        <>
          <PageHeader
            title="Eval"
            back={<Link href="/me/skills">Skills</Link>}
            description={`Started ${new Date((live ?? first).startedAt).toLocaleString()}`}
          />
          {stalled && (
            <Notice tone="warn">
              <p>{STALLED_MESSAGE}</p>
            </Notice>
          )}
          <ShownRun run={live ?? first} />
        </>
      )}
    </ResourceView>
  );
}
