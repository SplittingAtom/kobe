"use client";

import Link from "next/link";
import { useState } from "react";
import {
  listAgentInventory,
  setInventoryAgentStatus,
  type InventoryAgent,
  type InventoryPage,
  type InventorySchedule,
} from "../../../lib/admin/api/team/agents";
import { consoleHref } from "../../../lib/admin/nav/registry";
import { scoreLabel } from "../../../lib/admin/orbit-score";
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
  useConfirm,
  eventTrigger,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { OrbitExportButton } from "./agent-builder/orbit-export-button";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

const SCOPE_LABEL = { team: "Team", personal: "Personal", gallery: "Gallery" } as const;
const PLACEHOLDER = "—";

/**
 * Inventory for team admins (KOBE-86, D19): team agents plus members' personal agents used in
 * this team, with owner, scope, status, versions, usage counts and the latest Orbit score
 * (KOBE-94) and the team's schedules of each agent (KOBE-180). Suspending a personal agent affects
 * this team only; a suspended agent's schedules do not fire.
 */
export function AgentInventory({
  teamId,
  canSuspend,
}: {
  readonly teamId: string;
  readonly canSuspend: boolean;
}) {
  const { state } = useResource(() => listAgentInventory(teamId));
  return (
    <Section
      id="inventory-heading"
      title="Agents"
      description={
        <>
          Team agents and members&apos; personal agents used in this team, with their schedules.
          Suspending a personal agent only stops it in this team; a suspended agent&apos;s schedules
          don&apos;t fire. Pause schedules in{" "}
          <Link href={`${consoleHref("team")}/schedules`}>Schedules</Link>.
        </>
      }
    >
      <ResourceView state={state} label="the agent inventory">
        {(first) => <InventoryTable teamId={teamId} first={first} canSuspend={canSuspend} />}
      </ResourceView>
    </Section>
  );
}

function InventoryTable({
  teamId,
  first,
  canSuspend,
}: {
  readonly teamId: string;
  readonly first: InventoryPage;
  readonly canSuspend: boolean;
}) {
  const [agents, setAgents] = useState<readonly InventoryAgent[]>(first.agents);
  const [cursor, setCursor] = useState<string | null>(first.nextCursor);
  const mutation = useMutation();
  const paging = useMutation();
  const [confirm, confirmDialog] = useConfirm();

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

  async function toggle(agent: InventoryAgent, trigger: HTMLElement | null) {
    const next = agent.status === "active" ? "suspended" : "active";
    if (
      next === "suspended" &&
      !(await confirm(
        {
          title: `Suspend ${agent.name}?`,
          description: "It can't start new runs in this team.",
          confirmLabel: `Suspend ${agent.name}`,
        },
        trigger,
      ))
    ) {
      return;
    }
    const done = await mutation.run(
      () => setInventoryAgentStatus(teamId, agent.id, next),
      () => `${agent.name} is ${next}.`,
    );
    if (done) {
      setAgents((current) => current.map((a) => (a.id === agent.id ? { ...a, status: next } : a)));
    }
  }

  if (agents.length === 0) return <EmptyState title="No agents yet." />;
  return (
    <>
      <MutationStatus error={mutation.error ?? paging.error} notice={mutation.notice} />
      <Table caption="Agent inventory">
        <TableHead>
          <TableRow>
            <TableHeader>Agent</TableHeader>
            <TableHeader>Owner</TableHeader>
            <TableHeader>Scope</TableHeader>
            <TableHeader>Status</TableHeader>
            <TableHeader>Versions</TableHeader>
            <TableHeader numeric>Runs</TableHeader>
            <TableHeader>Last run</TableHeader>
            <TableHeader numeric>Tokens</TableHeader>
            <TableHeader>Schedules</TableHeader>
            <TableHeader>Orbit score</TableHeader>
            <TableHeader>
              <span className="sr-only">Actions</span>
            </TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {agents.map((a) => (
            <TableRow key={a.id}>
              <TableRowHeader>{a.name}</TableRowHeader>
              <TableCell>
                {a.scope === "gallery" ? "Gallery" : (a.ownerName ?? PLACEHOLDER)}
              </TableCell>
              <TableCell>{SCOPE_LABEL[a.scope]}</TableCell>
              <TableCell>
                {a.archivedAt !== null
                  ? "Archived"
                  : a.status === "active"
                    ? "Active"
                    : "Suspended"}
              </TableCell>
              <TableCell>{a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}</TableCell>
              <TableCell numeric>{a.runCount.toLocaleString("en-US")}</TableCell>
              <TableCell>
                {a.lastRunAt === null ? PLACEHOLDER : <DateTime value={a.lastRunAt} />}
              </TableCell>
              <TableCell numeric>{a.tokens.toLocaleString("en-US")}</TableCell>
              <TableCell>
                <ScheduleList schedules={a.schedules} />
              </TableCell>
              <TableCell>
                {a.orbitScore.status === "none" ? (
                  PLACEHOLDER
                ) : (
                  <>
                    {scoreLabel(a.orbitScore)}
                    {a.orbitScore.at !== null && a.orbitScore.status !== "evaluating" && (
                      <div className="text-sm text-console-muted">
                        <DateTime value={a.orbitScore.at} />
                      </div>
                    )}
                  </>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1.5">
                  {a.canExport === true && a.currentVersion !== null && (
                    <OrbitExportButton
                      teamId={teamId}
                      agentId={a.id}
                      agentSlug={a.slug}
                      version={a.currentVersion}
                      label={`Export ${a.name} to Orbit`}
                      size="sm"
                    />
                  )}
                  {canSuspend && (
                    <Button
                      size="sm"
                      variant={a.status === "active" ? "danger" : "secondary"}
                      disabled={mutation.pending}
                      onClick={(e) => void toggle(a, eventTrigger(e))}
                    >
                      {a.status === "active" ? "Suspend" : "Reactivate"}
                      <span className="sr-only"> {a.name}</span>
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {cursor !== null && (
        <p>
          <Button loading={paging.pending} onClick={() => void loadMore()}>
            Load more
          </Button>
        </p>
      )}
      {confirmDialog}
    </>
  );
}

const PAUSED_BY_LABEL = {
  team_admin: "paused by a team admin",
  deactivation: "paused (owner deactivated or removed)",
} as const;

function scheduleLabel(s: InventorySchedule): string {
  if (s.status === "active") return "active";
  return s.pausedBy === null ? "paused" : PAUSED_BY_LABEL[s.pausedBy];
}

/** Owner and status of each schedule; team admins pause them from the schedules API. */
function ScheduleList({ schedules }: { readonly schedules: readonly InventorySchedule[] }) {
  if (schedules.length === 0) return <>{PLACEHOLDER}</>;
  return (
    <ul className="m-0 list-none p-0">
      {schedules.map((s) => (
        <li key={s.scheduleId}>
          {s.ownerName}: {scheduleLabel(s)}
        </li>
      ))}
    </ul>
  );
}
