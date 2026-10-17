"use client";

import { listTeamGrants, type TeamGrant } from "../../../lib/admin/api/team/break-glass";
import {
  EmptyState,
  Notice,
  PageHeader,
  Section,
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

function scopeText(g: TeamGrant): string {
  switch (g.scope) {
    case "restricted":
      return "Restricted (legal hold)";
    case "user":
      return `Threads of ${g.subject?.name ?? "one member"}`;
    case "thread":
      return `Thread ${g.threadId ?? ""}`;
    default:
      return "All of the team's threads";
  }
}

function approval(g: TeamGrant): string {
  if (!g.approvedBy) return "";
  return g.selfApproved
    ? `Self-approved by ${g.approvedBy.name}: single-admin site (flagged).`
    : `Approved by ${g.approvedBy.name}.`;
}

/** One banner per active grant: who can read what, until when, and why (unless a legal hold). */
export function BreakGlassBanners({ grants }: { readonly grants: readonly TeamGrant[] }) {
  return (
    <>
      {grants.map((g) => (
        <Notice key={g.id} tone="warn" role="note" aria-label="Active break-glass access">
          <p>
            <strong>{g.requestedBy.name}</strong> (site admin) has read-only break-glass access to
            this team until <DateTime value={g.expiresAt} />. Scope: {scopeText(g)}. {approval(g)}
            {g.reason && <> Reason: {g.reason}</>}
          </p>
        </Notice>
      ))}
    </>
  );
}

/**
 * Break-glass on this team (spec D10; `/v1/team/break-glass`, team admins): banners for active
 * access and the history of grants. Each read under a grant is in the team's audit log as
 * `governance.break_glass.read`.
 */
export function TeamBreakGlassPage() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listTeamGrants(teamId));

  return (
    <>
      <PageHeader
        title="Break-glass access"
        description="Site admins can read this team's content only through break-glass: read-only, time-boxed, approved by a second site admin, and recorded read by read in the team's audit log."
      />
      <ResourceView state={state} label="break-glass access">
        {({ active, recent }) => (
          <>
            {active.length === 0 ? (
              <Notice role="status">
                <p>No site admin has break-glass access to this team now.</p>
              </Notice>
            ) : (
              <BreakGlassBanners grants={active} />
            )}
            <Section title="History">
              {recent.length === 0 ? (
                <EmptyState title="No earlier break-glass access." />
              ) : (
                <Table caption="Earlier grants">
                  <TableHead>
                    <TableRow>
                      <TableHeader>Site admin</TableHeader>
                      <TableHeader>Scope</TableHeader>
                      <TableHeader>Reason</TableHeader>
                      <TableHeader>From</TableHeader>
                      <TableHeader>Until</TableHeader>
                      <TableHeader>Ended</TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {recent.map((g) => (
                      <TableRow key={g.id}>
                        <TableRowHeader>
                          {g.requestedBy.name}
                          <div className="text-sm font-normal text-console-muted">
                            {approval(g)}
                          </div>
                        </TableRowHeader>
                        <TableCell>{scopeText(g)}</TableCell>
                        <TableCell>{g.reason ?? "Not shown (legal hold)"}</TableCell>
                        <TableCell>
                          <DateTime value={g.startsAt} />
                        </TableCell>
                        <TableCell>
                          <DateTime value={g.expiresAt} />
                        </TableCell>
                        <TableCell>{g.status === "revoked" ? "Revoked" : "Expired"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>
          </>
        )}
      </ResourceView>
    </>
  );
}
