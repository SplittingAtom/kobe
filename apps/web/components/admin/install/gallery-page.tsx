"use client";

import { agentStatusLabel } from "../../../lib/admin/api/agents";
import {
  galleryExportHref,
  listGalleryAgents,
  listGalleryScores,
  listMyTeamsForEval,
  runGalleryEval,
} from "../../../lib/admin/api/install/gallery";
import { MutationStatus } from "../error-notice";
import { GalleryScoreCell } from "../gallery-score";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { useState } from "react";
import styles from "../admin.module.css";

/**
 * Gallery agents (spec D19/D21; `/v1/install/gallery/agents`), read-only: they come from the
 * definitions in the repository, seeded at install and upgrade (KOBE-87). Teams fork them.
 */
export function GalleryPage() {
  const { state } = useResource(listGalleryAgents);
  const scores = useResource(listGalleryScores);
  const teams = useResource(listMyTeamsForEval).state;
  const mutation = useMutation();
  const [teamId, setTeamId] = useState("");
  const myTeams = teams.status === "ready" ? teams.data.teams : [];
  const hostTeam = teamId || myTeams[0]?.id || "";

  return (
    <>
      <h1>Gallery agents</h1>
      <p className={styles.hint}>
        Gallery agents are available to every team, read-only; teams fork them to change them. They
        come from the definitions shipped with Kobe and update with each release. A team can suspend
        a gallery agent for itself in its agent inventory.
      </p>
      <p className={styles.hint}>
        Orbit scores are published for every team to see. An eval runs in a team you belong to (its
        sandbox runtime and model budget) and takes several minutes; reload to see the score.
      </p>
      {myTeams.length > 0 && (
        <p>
          <label>
            Run evals in team{" "}
            <select value={hostTeam} onChange={(e) => setTeamId(e.target.value)}>
              {myTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </p>
      )}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="gallery agents">
        {(agents) =>
          agents.length === 0 ? (
            <p>The gallery is empty.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Gallery</caption>
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Slug</th>
                    <th scope="col">Status</th>
                    <th scope="col">Version</th>
                    <th scope="col">Orbit score</th>
                    <th scope="col">Updated</th>
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
                      <td>
                        <code>{a.slug}</code>
                      </td>
                      <td>{agentStatusLabel(a)}</td>
                      <td>{a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}</td>
                      <td>
                        <GalleryScoreCell agentId={a.id} state={scores.state} />
                      </td>
                      <td>
                        <DateTime value={a.updatedAt} />
                      </td>
                      <td>
                        {a.currentVersion !== null && hostTeam !== "" && (
                          <button
                            type="button"
                            disabled={mutation.pending}
                            onClick={() =>
                              void mutation.run(
                                () => runGalleryEval(a.id, hostTeam),
                                () =>
                                  `Evaluating ${a.name}. The score appears here when it finishes.`,
                              )
                            }
                          >
                            Run eval<span className={styles.visuallyHidden}> for {a.name}</span>
                          </button>
                        )}{" "}
                        <a href={galleryExportHref(a.id)} download={`${a.slug}.md`}>
                          Export<span className={styles.visuallyHidden}> {a.name}</span>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </>
  );
}
