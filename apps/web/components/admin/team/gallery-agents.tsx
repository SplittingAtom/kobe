"use client";

import Link from "next/link";
import { useState } from "react";
import type { AgentSummary } from "../../../lib/admin/api/agents";
import {
  forkGalleryAgent,
  listGalleryAgents,
  listGalleryScores,
} from "../../../lib/admin/api/team/agents";
import { GalleryScoreCell } from "../gallery-score";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

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
    <section aria-labelledby="gallery-heading">
      <h2 id="gallery-heading">Gallery</h2>
      <p className={styles.hint}>
        Gallery agents are available to every team and can&apos;t be edited. Fork one to get a team
        agent you can change and publish.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {forked && (
        <p>
          <Link href={`/admin/team/agents/${forked.id}`}>Open {forked.name}</Link>
        </p>
      )}
      <ResourceView state={state} label="the gallery">
        {(agents) =>
          agents.length === 0 ? (
            <p>The gallery is empty.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Gallery agents</caption>
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Version</th>
                    <th scope="col">Orbit score</th>
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.id}>
                      <th scope="row">
                        {a.name}
                        {a.description && <div className={styles.hint}>{a.description}</div>}
                      </th>
                      <td>{a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}</td>
                      <td>
                        <GalleryScoreCell agentId={a.id} state={scores} />
                      </td>
                      <td>
                        {canFork && (
                          <button
                            type="button"
                            disabled={mutation.pending}
                            onClick={() => void fork(a)}
                          >
                            Fork to team
                            <span className={styles.visuallyHidden}> {a.name}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </section>
  );
}
