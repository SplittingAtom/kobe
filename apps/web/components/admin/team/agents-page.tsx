"use client";

import { listTeamAgents, setTeamAgentStatus } from "../../../lib/admin/api/team";
import type { AgentSummary } from "../../../lib/admin/api/install";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/** Team agents (spec D19; `/v1/agents?scope=team`): team admins suspend and reactivate them. */
export function TeamAgentsPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { state, reload } = useResource(() => listTeamAgents(teamId));
  const mutation = useMutation();

  async function toggle(agent: AgentSummary) {
    const next = agent.status === "active" ? "suspended" : "active";
    if (
      next === "suspended" &&
      !confirmed(`Suspend ${agent.name}? Nobody in the team can start new conversations with it.`)
    ) {
      return;
    }
    const done = await mutation.run(
      () => setTeamAgentStatus(teamId, agent.id, next),
      () => `${agent.name} is ${next}.`,
    );
    if (done) reload();
  }

  return (
    <>
      <h1>Team agents</h1>
      <p className={styles.hint}>
        Builders create and publish team agents; team admins can suspend any of them. The full
        inventory (versions, usage, schedules) arrives with KOBE-48.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="team agents">
        {(agents) =>
          agents.length === 0 ? (
            <p>{access.team.name} has no team agents yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Agents of {access.team.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Slug</th>
                    <th scope="col">Status</th>
                    <th scope="col">Version</th>
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
                      <td>{a.status === "active" ? "Active" : "Suspended"}</td>
                      <td>{a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}</td>
                      <td>
                        <DateTime value={a.updatedAt} />
                      </td>
                      <td>
                        <button
                          type="button"
                          disabled={mutation.pending}
                          onClick={() => void toggle(a)}
                        >
                          {a.status === "active" ? "Suspend" : "Reactivate"}
                          <span className={styles.visuallyHidden}> {a.name}</span>
                        </button>
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
