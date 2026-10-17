"use client";

import {
  disableTeamDomain,
  enableTeamDomain,
  listTeamEgress,
  type TeamEgressDomain,
} from "../../../lib/admin/api/team/egress";
import {
  Button,
  Checkbox,
  EmptyState,
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
import { SharedHostingNote } from "../shared-hosting-note";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { DomainHeaders } from "./egress-headers";
import { EgressRequests } from "./egress-requests";

/**
 * Team egress (spec D6/D28; `/v1/team/egress`): enablement (KOBE-38), access requests and injected
 * headers (KOBE-39).
 */
export function TeamEgressPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => listTeamEgress(teamId));
  const mutation = useMutation();

  async function toggle(d: TeamEgressDomain) {
    const done = await mutation.run(
      () => (d.enabled ? disableTeamDomain(teamId, d.domain) : enableTeamDomain(teamId, d.domain)),
      () =>
        d.enabled
          ? `Disabled ${d.domain}: the team's sandboxes can no longer reach it.`
          : `Enabled ${d.domain} for the team's sandboxes.`,
    );
    if (done) reload();
  }

  return (
    <>
      <PageHeader
        title="Egress"
        description="Your team's sandboxes reach nothing on the internet until you enable a domain here, and only domains in the site's egress ceiling can be enabled. Connections are HTTPS only and logged to the audit view. Members can't enable domains themselves: when their sandbox is blocked they can request access, and you approve or deny it here."
      />
      <EgressRequests onDecided={reload} />
      <Section title="Domains">
        <MutationStatus error={mutation.error} notice={mutation.notice} />
        <ResourceView state={state} label="egress domains">
          {(domains) =>
            domains.length === 0 ? (
              <EmptyState title="The site ceiling is empty: ask a site admin to add domains." />
            ) : (
              <Table caption={`Domains (${domains.length})`}>
                <TableHead>
                  <TableRow>
                    <TableHeader>Domain</TableHeader>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>Enabled</TableHeader>
                    <TableHeader>Since</TableHeader>
                    <TableHeader>Injected headers</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {domains.map((d) => (
                    <TableRow key={d.domain}>
                      <TableRowHeader>
                        <code>{d.domain}</code>
                        {d.sharedHosting ? <SharedHostingNote /> : null}
                      </TableRowHeader>
                      <TableCell>
                        {!d.inCeiling
                          ? "Suspended (not in the site ceiling)"
                          : d.enabled
                            ? "Enabled"
                            : "Off"}
                      </TableCell>
                      <TableCell>
                        {d.inCeiling ? (
                          <Checkbox
                            label={<span className="sr-only">{d.domain} enabled</span>}
                            checked={d.enabled}
                            disabled={mutation.pending}
                            onChange={() => void toggle(d)}
                          />
                        ) : (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={mutation.pending}
                            onClick={() => void toggle(d)}
                          >
                            Disable<span className="sr-only"> {d.domain}</span>
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <DateTime value={d.enabledAt} />
                      </TableCell>
                      <TableCell>
                        {d.enabled && !d.domain.startsWith("*.") ? (
                          <DomainHeaders
                            teamId={teamId}
                            domain={d}
                            mutation={mutation}
                            onChanged={reload}
                          />
                        ) : (
                          <span className="text-console-muted">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </ResourceView>
      </Section>
    </>
  );
}
