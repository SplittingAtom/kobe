"use client";

import { useState } from "react";
import {
  decideSiteEgressRequest,
  listSiteEgressRequests,
  type SiteEgressRequest,
} from "../../../lib/admin/api/site/egress";
import { patternChoices } from "../../../lib/egress-patterns";
import {
  Button,
  Checkbox,
  EmptyState,
  Select,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useFocusAfterRemoval } from "../use-focus-after-removal";
import { useMutation, useResource } from "../use-resource";

const HEADING = "site-egress-requests";

/**
 * Site-scope access requests (egress access, KOBE-602/604): a team's sandbox was blocked from a
 * host outside the ceiling (or on an internal address) and a member asked. Approve puts the chosen
 * pattern in the ceiling (marked internal if asked) and enables it for the team; Deny tells the
 * requester. The same decision the blocked card offers a site admin.
 */
export function SiteEgressRequests({ onDecided }: { readonly onDecided: () => void }) {
  const { state, reload } = useResource(listSiteEgressRequests);
  const mutation = useMutation();
  const ids = state.status === "ready" ? state.data.map((r) => r.id) : null;
  const focus = useFocusAfterRemoval(ids, HEADING);

  async function decide(
    r: SiteEgressRequest,
    index: number,
    decision: "approve" | "deny",
    pattern: string,
    internal: boolean,
  ) {
    const done = await mutation.run(
      () =>
        decideSiteEgressRequest(
          r,
          decision === "approve"
            ? { decision, pattern, ...(internal ? { internal: true } : {}) }
            : { decision },
        ),
      (res) =>
        decision === "approve"
          ? `Enabled ${res.pattern} for ${r.team.name}. ${r.requestedBy.name} was told.`
          : `Denied ${r.domain} for ${r.team.name}. ${r.requestedBy.name} was told.`,
    );
    if (done) {
      focus.removed(r.id, index);
      reload();
      onDecided();
    }
  }

  return (
    <Section id={HEADING} title="Access requests">
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="access requests">
        {(requests) =>
          requests.length === 0 ? (
            <EmptyState title="No pending requests." />
          ) : (
            <div ref={focus.container}>
              <Table caption={`Pending site requests (${requests.length})`}>
                <TableHead>
                  <TableRow>
                    <TableHeader>Blocked host</TableHeader>
                    <TableHeader>Team</TableHeader>
                    <TableHeader>Requested by</TableHeader>
                    <TableHeader>When</TableHeader>
                    <TableHeader>Decision</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {requests.map((r, index) => (
                    <RequestRow
                      key={r.id}
                      request={r}
                      pending={mutation.pending}
                      onDecide={(decision, pattern, internal) =>
                        void decide(r, index, decision, pattern, internal)
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      </ResourceView>
    </Section>
  );
}

function RequestRow({
  request: r,
  pending,
  onDecide,
}: {
  readonly request: SiteEgressRequest;
  readonly pending: boolean;
  readonly onDecide: (decision: "approve" | "deny", pattern: string, internal: boolean) => void;
}) {
  const choices = patternChoices(r.domain);
  const [pattern, setPattern] = useState(choices.includes(r.pattern) ? r.pattern : r.domain);
  const [internal, setInternal] = useState(r.internal);
  return (
    <TableRow>
      <TableRowHeader>
        <code>{r.domain}</code>
        {r.internal ? (
          <span className="text-sm text-console-muted"> (internal address)</span>
        ) : null}
      </TableRowHeader>
      <TableCell>{r.team.name}</TableCell>
      <TableCell>
        {r.requestedBy.name}
        {r.threadId ? (
          <span className="text-sm text-console-muted"> (thread {r.threadId.slice(0, 8)})</span>
        ) : null}
      </TableCell>
      <TableCell>
        <DateTime value={r.createdAt} />
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            aria-label={`Pattern to enable for ${r.domain}`}
            value={pattern}
            disabled={pending}
            onChange={(e) => setPattern(e.target.value)}
          >
            {choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Checkbox
            label={
              <>
                Internal (same cluster)
                <span className="sr-only"> for {r.domain}</span>
              </>
            }
            checked={internal}
            disabled={pending}
            onChange={(e) => setInternal(e.target.checked)}
          />
          <Button
            size="sm"
            variant="primary"
            data-remove=""
            disabled={pending}
            onClick={() => onDecide("approve", pattern, internal)}
          >
            Approve
            <span className="sr-only">
              {" "}
              {r.domain} for {r.team.name}
            </span>
          </Button>
          <Button
            size="sm"
            variant="danger"
            data-remove=""
            disabled={pending}
            onClick={() => onDecide("deny", pattern, internal)}
          >
            Deny
            <span className="sr-only">
              {" "}
              {r.domain} for {r.team.name}
            </span>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
