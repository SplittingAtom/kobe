"use client";

import Link from "next/link";
import { agentStatusLabel } from "../../lib/admin/api/agents";
import { listPersonalAgents } from "../../lib/admin/api/team/agents";
import { useTeamAccess } from "../admin/console-context";
import { DateTime, ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import styles from "../admin/admin.module.css";

/** A member's own personal agents (`/v1/agents?scope=personal`, KOBE-45/97). */
export function MyAgentsPage() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listPersonalAgents(teamId));
  return (
    <>
      <h1>My agents</h1>
      <p className={styles.hint}>
        Personal agents are yours alone: only you can see, edit and publish them, and they follow
        you into every team you belong to.
      </p>
      <p>
        <Link href="/me/agents/new">New agent</Link> ·{" "}
        <Link href="/me/connectors">My connector keys</Link>
      </p>
      <ResourceView state={state} label="your agents">
        {(agents) =>
          agents.length === 0 ? (
            <p>You have no personal agents yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Your personal agents</caption>
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
                        <Link href={`/me/agents/${a.id}`}>
                          Edit
                          <span className={styles.visuallyHidden}> {a.name}</span>
                        </Link>
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
