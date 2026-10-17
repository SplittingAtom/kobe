"use client";

import Link from "next/link";
import { listTeamAgents } from "../../../lib/admin/api/team/agents";
import { agentStatusLabel } from "../../../lib/admin/api/agents";
import {
  Button,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { GalleryAgents } from "./gallery-agents";

/** Team agents (spec D19; `/v1/agents?scope=team`); team admins suspend them in the Inventory. */
export function TeamAgentsPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const canSuspend = access.permissions.includes("team.agents.suspend");
  const canFork = access.permissions.includes("team.agents.build");
  const { state, reload } = useResource(() => listTeamAgents(teamId));
  return (
    <>
      <PageHeader
        title="Team agents"
        description={
          <>
            Builders create and publish team agents
            {canSuspend ? (
              <>
                ; team admins suspend them, and see their usage, schedules and Orbit scores, in the{" "}
                <Link href="/admin/team/inventory">Inventory</Link>
              </>
            ) : null}
            . Archived agents were deleted after publishing: conversations pinned to them keep
            working.
          </>
        }
        actions={
          <Button asChild variant="primary">
            <Link href="/admin/team/agents/new">New agent</Link>
          </Button>
        }
      />
      <ResourceView state={state} label="team agents">
        {(agents) =>
          agents.length === 0 ? (
            <EmptyState title={`${access.team.name} has no team agents yet.`} />
          ) : (
            <Table caption={`Agents of ${access.team.name}`}>
              <TableHead>
                <TableRow>
                  <TableHeader>Agent</TableHeader>
                  <TableHeader>Slug</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader>Version</TableHeader>
                  <TableHeader>Updated</TableHeader>
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
                      <code>{a.slug}</code>
                    </TableCell>
                    <TableCell>{agentStatusLabel(a)}</TableCell>
                    <TableCell>
                      {a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}
                    </TableCell>
                    <TableCell>
                      <DateTime value={a.updatedAt} />
                    </TableCell>
                    <TableCell>
                      <Link href={`/admin/team/agents/${a.id}`}>
                        Edit
                        <span className="sr-only"> {a.name}</span>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
      <GalleryAgents teamId={teamId} canFork={canFork} onForked={reload} />
    </>
  );
}
