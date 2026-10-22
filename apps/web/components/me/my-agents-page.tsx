"use client";

import Link from "next/link";
import { agentStatusLabel } from "../../lib/admin/api/agents";
import { listPersonalAgents } from "../../lib/admin/api/team/agents";
import { useTeamAccess } from "../admin/console-context";
import { DateTime, ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { AgentIconGlyph } from "../admin/team/agent-builder/icon-picker";
import { DangerousBadge } from "../admin/team/agent-builder/dangerous-badge";
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
} from "../ui/console";

/** A member's own personal agents (`/v1/agents?scope=personal`, KOBE-45/97). */
export function MyAgentsPage() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listPersonalAgents(teamId));
  return (
    <>
      <PageHeader
        title="My agents"
        description="Personal agents are yours alone: only you can see, edit and publish them, and they follow you into every team you belong to."
        actions={
          <>
            <Button asChild>
              <Link href="/me/connectors">My connector keys</Link>
            </Button>
            <Button asChild variant="primary">
              <Link href="/me/agents/new">New agent</Link>
            </Button>
          </>
        }
      />
      <ResourceView state={state} label="your agents">
        {(agents) =>
          agents.length === 0 ? (
            <EmptyState title="You have no personal agents yet." />
          ) : (
            <Table caption="Your personal agents">
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
                      <span className="inline-flex items-center gap-2">
                        {a.icon && <AgentIconGlyph name={a.icon} />}
                        {a.name}
                        {a.dangerous && <DangerousBadge />}
                      </span>
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
                      <Link href={`/me/agents/${a.id}`}>
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
    </>
  );
}
