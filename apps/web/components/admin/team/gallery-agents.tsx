"use client";

import Link from "next/link";
import { useState } from "react";
import type { AgentSummary } from "../../../lib/admin/api/agents";
import {
  forkGalleryAgent,
  listGalleryAgents,
  listGalleryScores,
} from "../../../lib/admin/api/team/agents";
import {
  Button,
  EmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../ui/console";
import { GalleryScoreCell } from "../gallery-score";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/**
 * The gallery (KOBE-87, D19): agents every team can use, read-only. Builders fork one into an
 * editable team agent (`team.agents.build`); the fork's draft opens in the builder.
 */
export function GalleryAgents({
  teamId,
  canFork,
  onForked,
}: {
  readonly teamId: string;
  readonly canFork: boolean;
  readonly onForked: () => void;
}) {
  const { state } = useResource(() => listGalleryAgents(teamId));
  // Scores are secondary: if they can't load, the cards still show.
  const scores = useResource(() => listGalleryScores(teamId)).state;
  const mutation = useMutation();
  const [forked, setForked] = useState<AgentSummary | null>(null);

  async function fork(agent: AgentSummary) {
    setForked(null);
    const done = await mutation.run(
      async () => {
        const res = await forkGalleryAgent(teamId, agent.id);
        if (res.ok) setForked(res.data.agent);
        return res;
      },
      () => `Forked ${agent.name} into your team's agents.`,
    );
    if (done) onForked();
  }

  return (
    <Section
      id="gallery-heading"
      title="Gallery"
      description="Gallery agents are available to every team and can't be edited. Fork one to get a team agent you can change and publish."
    >
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {forked && (
        <p>
          <Link href={`/admin/team/agents/${forked.id}`}>Open {forked.name}</Link>
        </p>
      )}
      <ResourceView state={state} label="the gallery">
        {(agents) =>
          agents.length === 0 ? (
            <EmptyState title="The gallery is empty." />
          ) : (
            <Table caption="Gallery agents">
              <TableHead>
                <TableRow>
                  <TableHeader>Agent</TableHeader>
                  <TableHeader>Version</TableHeader>
                  <TableHeader>Orbit score</TableHeader>
                  <TableHeader>
                    <span className="sr-only">Actions</span>
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {agents.map((a) => (
                  <TableRow key={a.id}>
                    <TableRowHeader>
                      {a.name}
                      {a.description && (
                        <div className="text-sm font-normal text-console-muted">
                          {a.description}
                        </div>
                      )}
                    </TableRowHeader>
                    <TableCell>
                      {a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}
                    </TableCell>
                    <TableCell>
                      <GalleryScoreCell agentId={a.id} state={scores} />
                    </TableCell>
                    <TableCell>
                      {canFork && (
                        <Button size="sm" disabled={mutation.pending} onClick={() => void fork(a)}>
                          Fork to team
                          <span className="sr-only"> {a.name}</span>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
    </Section>
  );
}
