"use client";

import Link from "next/link";
import { listTeamAgents } from "../../../lib/admin/api/team/agents";
import { agentStatusLabel } from "../../../lib/admin/api/agents";
import { useTeamAccess } from "../console-context";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { AgentInventory } from "./agent-inventory";
import styles from "../admin.module.css";

/** Team agents (spec D19; `/v1/agents?scope=team`) and, for team admins, the inventory (KOBE-86). */
export function TeamAgentsPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const canSuspend = access.permissions.includes("team.agents.suspend");
  const { state, reload } = useResource(() => listTeamAgents(teamId));
  return (
    <>
      <h1>Team agents</h1>
      <p className={styles.hint}>
        Builders create and publish team agents; team admins can suspend any of them in the
        inventory below. Archived agents were deleted after publishing: conversations pinned to them
        keep working.
      </p>
      <p>
        <Link href="/admin/team/agents/new">New agent</Link>
      </p>
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
                      <td>{agentStatusLabel(a)}</td>
                      <td>{a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}</td>
                      <td>
                        <DateTime value={a.updatedAt} />
                      </td>
                      <td>
                        <Link href={`/admin/team/agents/${a.id}`}>
                          Edit
                          <span className={styles.visuallyHidden}> {a.name}</span>
                        </Link>{" "}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
      {canSuspend && <AgentInventory teamId={teamId} canSuspend onChanged={reload} />}
    </>
  );
}
