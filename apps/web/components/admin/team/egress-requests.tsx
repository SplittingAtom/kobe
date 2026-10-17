"use client";

import {
  decideEgressRequest,
  listEgressRequests,
  type TeamEgressRequest,
} from "../../../lib/admin/api/team/egress";
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
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/**
 * Pending access requests (KOBE-39, D28): a member's sandbox was blocked from a host and they asked
 * for it. Approve enables the ceiling pattern shown (and settles everyone's requests for it);
 * deny tells the requesters. Only domain and thread metadata are shown.
 */
export function EgressRequests({ onDecided }: { readonly onDecided: () => void }) {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => listEgressRequests(teamId));
  const mutation = useMutation();

  async function decide(r: TeamEgressRequest, decision: "approve" | "deny") {
    const done = await mutation.run(
      () => decideEgressRequest(teamId, r.id, decision),
      () =>
        decision === "approve"
          ? `Approved: ${r.pattern} is enabled for the team's sandboxes. ${r.requestedBy.name} was told.`
          : `Denied ${r.pattern}. ${r.requestedBy.name} was told.`,
    );
    if (done) {
      reload();
      onDecided();
    }
  }

  return (
    <Section id="egress-requests" title="Access requests">
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="access requests">
        {(requests) =>
          requests.length === 0 ? (
            <EmptyState title="No pending requests." />
          ) : (
            <Table caption={`Pending requests (${requests.length})`}>
              <TableHead>
                <TableRow>
                  <TableHeader>Blocked host</TableHeader>
                  <TableHeader>Enables</TableHeader>
                  <TableHeader>Requested by</TableHeader>
                  <TableHeader>When</TableHeader>
                  <TableHeader>Decision</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {requests.map((r) => (
                  <TableRow key={r.id}>
                    <TableRowHeader>
                      <code>{r.domain}</code>
                    </TableRowHeader>
                    <TableCell>
                      <code>{r.pattern}</code>
                    </TableCell>
                    <TableCell>
                      {r.requestedBy.name}
                      {r.threadId ? (
                        <span className="text-sm text-console-muted">
                          {" "}
                          (thread {r.threadId.slice(0, 8)})
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <DateTime value={r.createdAt} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={mutation.pending}
                          onClick={() => void decide(r, "approve")}
                        >
                          Approve<span className="sr-only"> {r.domain}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={mutation.pending}
                          onClick={() => void decide(r, "deny")}
                        >
                          Deny<span className="sr-only"> {r.domain}</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
    </Section>
  );
}
