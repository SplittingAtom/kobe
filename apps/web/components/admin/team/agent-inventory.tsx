"use client";

import { useState } from "react";
import {
  listAgentInventory,
  setInventoryAgentStatus,
  type InventoryAgent,
  type InventoryPage,
} from "../../../lib/admin/api/team/agents";
import { scoreLabel } from "../../../lib/admin/orbit-score";
import { MutationStatus } from "../error-notice";
import { OrbitExportButton } from "./agent-builder/orbit-export-button";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

const SCOPE_LABEL = { team: "Team", personal: "Personal", gallery: "Gallery" } as const;
const PLACEHOLDER = "—";

/**
 * Inventory for team admins (KOBE-86, D19): team agents plus members' personal agents used in
 * this team, with owner, scope, status, versions, usage counts and the latest Orbit score
 * (KOBE-94). Schedules (KOBE-64) are a placeholder. Suspending a personal agent affects this team only.
 */
export function AgentInventory({
  teamId,
  canSuspend,
  onChanged,
}: {
  readonly teamId: string;
  readonly canSuspend: boolean;
  readonly onChanged: () => void;
}) {
  const { state } = useResource(() => listAgentInventory(teamId));
  return (
    <section aria-labelledby="inventory-heading">
      <h2 id="inventory-heading">Inventory</h2>
      <p className={styles.hint}>
        Team agents and members&apos; personal agents used in this team. Suspending a personal agent
        only stops it in this team.
      </p>
      <ResourceView state={state} label="the agent inventory">
        {(first) => (
          <InventoryTable
            teamId={teamId}
            first={first}
            canSuspend={canSuspend}
            onChanged={onChanged}
          />
        )}
      </ResourceView>
    </section>
  );
}

function InventoryTable({
  teamId,
  first,
  canSuspend,
  onChanged,
}: {
  readonly teamId: string;
  readonly first: InventoryPage;
  readonly canSuspend: boolean;
  readonly onChanged: () => void;
}) {
  const [agents, setAgents] = useState<readonly InventoryAgent[]>(first.agents);
  const [cursor, setCursor] = useState<string | null>(first.nextCursor);
  const mutation = useMutation();
  const paging = useMutation();

  async function loadMore() {
    if (cursor === null) return;
    await paging.run(
      () => listAgentInventory(teamId, cursor),
      (page: InventoryPage) => {
        setAgents((current) => [...current, ...page.agents]);
        setCursor(page.nextCursor);
        return null;
      },
    );
  }

  async function toggle(agent: InventoryAgent) {
    const next = agent.status === "active" ? "suspended" : "active";
    if (
      next === "suspended" &&
      !confirmed(`Suspend ${agent.name}? It can't start new runs in this team.`)
    ) {
      return;
    }
    const done = await mutation.run(
      () => setInventoryAgentStatus(teamId, agent.id, next),
      () => `${agent.name} is ${next}.`,
    );
    if (done) {
      setAgents((current) => current.map((a) => (a.id === agent.id ? { ...a, status: next } : a)));
      onChanged();
    }
  }

  if (agents.length === 0) return <p>No agents yet.</p>;
  return (
    <>
      <MutationStatus error={mutation.error ?? paging.error} notice={mutation.notice} />
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>Agent inventory</caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Owner</th>
              <th scope="col">Scope</th>
              <th scope="col">Status</th>
              <th scope="col">Versions</th>
              <th scope="col">Runs</th>
              <th scope="col">Last run</th>
              <th scope="col">Tokens</th>
              <th scope="col">Schedules</th>
              <th scope="col">Orbit score</th>
              <th scope="col">
                <span className={styles.visuallyHidden}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <th scope="row">{a.name}</th>
                <td>{a.scope === "gallery" ? "Gallery" : (a.ownerName ?? PLACEHOLDER)}</td>
                <td>{SCOPE_LABEL[a.scope]}</td>
                <td>
                  {a.archivedAt !== null
                    ? "Archived"
                    : a.status === "active"
                      ? "Active"
                      : "Suspended"}
                </td>
                <td>{a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}</td>
                <td>{a.runCount.toLocaleString("en-US")}</td>
                <td>{a.lastRunAt === null ? PLACEHOLDER : <DateTime value={a.lastRunAt} />}</td>
                <td>{a.tokens.toLocaleString("en-US")}</td>
                <td>{PLACEHOLDER}</td>
                <td>
                  {a.orbitScore.status === "none" ? (
                    PLACEHOLDER
                  ) : (
                    <>
                      {scoreLabel(a.orbitScore)}
                      {a.orbitScore.at !== null && a.orbitScore.status !== "evaluating" && (
                        <div className={styles.hint}>
                          <DateTime value={a.orbitScore.at} />
                        </div>
                      )}
                    </>
                  )}
                </td>
                <td>
                  {a.canExport === true && a.currentVersion !== null && (
                    <OrbitExportButton
                      teamId={teamId}
                      agentId={a.id}
                      agentSlug={a.slug}
                      version={a.currentVersion}
                      label={`Export ${a.name} to Orbit`}
                    />
                  )}
                  {canSuspend && (
                    <button
                      type="button"
                      disabled={mutation.pending}
                      onClick={() => void toggle(a)}
                    >
                      {a.status === "active" ? "Suspend" : "Reactivate"}
                      <span className={styles.visuallyHidden}> {a.name}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor !== null && (
        <p>
          <button type="button" disabled={paging.pending} onClick={() => void loadMore()}>
            Load more
          </button>
        </p>
      )}
    </>
  );
}
