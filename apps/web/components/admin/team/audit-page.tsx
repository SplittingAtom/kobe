"use client";

import { useState } from "react";
import type { ApiError, ApiResult } from "../../../lib/api/client";
import { listTeamAudit, type TeamAuditEvent } from "../../../lib/admin/api/team/audit";
import { listTeamGrants, type TeamGrants } from "../../../lib/admin/api/team/break-glass";
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
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { ErrorNotice } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { BreakGlassBanners } from "./break-glass-page";

interface AuditData {
  readonly grants: TeamGrants;
  readonly events: readonly TeamAuditEvent[];
  readonly nextCursor: string | null;
}

async function loadAudit(teamId: string): Promise<ApiResult<AuditData>> {
  const [grants, page] = await Promise.all([listTeamGrants(teamId), listTeamAudit(teamId)]);
  if (!grants.ok) return grants;
  if (!page.ok) return page;
  return {
    ok: true,
    status: 200,
    data: { grants: grants.data, events: page.data.events, nextCursor: page.data.nextCursor },
  };
}

function actorName(e: TeamAuditEvent): string {
  if (e.actor.kind === "system") return "Kobe (system)";
  return e.actor.name ?? e.actor.id ?? "Unknown";
}

/**
 * The team's audit view (spec D6; `/v1/team/audit`): every event recorded for this team, newest
 * first, with a banner for each active break-glass grant (D10). Break-glass reads appear as
 * `governance.break_glass.read`, one per page a site admin opened.
 */
export function TeamAuditPage() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => loadAudit(teamId));
  const [more, setMore] = useState<readonly TeamAuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);

  return (
    <>
      <PageHeader title="Audit view" />
      <ResourceView state={state} label="audit events">
        {(data) => {
          const next = cursor === undefined ? data.nextCursor : cursor;
          const events = [...data.events, ...more];
          async function loadMore() {
            const res = await listTeamAudit(teamId, next);
            if (!res.ok) return setError(res.error);
            setError(null);
            setMore((prev) => [...prev, ...res.data.events]);
            setCursor(res.data.nextCursor);
          }
          return (
            <>
              <BreakGlassBanners grants={data.grants.active} />
              {events.length === 0 ? (
                <EmptyState title="No events yet." />
              ) : (
                <Table caption="Events, newest first">
                  <TableHead>
                    <TableRow>
                      <TableHeader>When</TableHeader>
                      <TableHeader>Who</TableHeader>
                      <TableHeader>What</TableHeader>
                      <TableHeader>Details</TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-nowrap">
                          <DateTime value={e.at} />
                        </TableCell>
                        <TableCell>{actorName(e)}</TableCell>
                        <TableCell>
                          <code>{e.action}</code>
                        </TableCell>
                        <TableCell>
                          <code className="break-all">{JSON.stringify(e.target)}</code>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {error && <ErrorNotice error={error} />}
              {next && (
                <Button className="mt-3" onClick={() => void loadMore()}>
                  Load more
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
