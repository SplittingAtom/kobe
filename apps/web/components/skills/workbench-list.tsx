"use client";

import Link from "next/link";
import { useState } from "react";
import { draftHref } from "./draft-href";
import { NewDraft } from "./new-draft";
import { listDrafts, type DraftSummary } from "../../lib/skills/drafts-api";
import {
  Badge,
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
} from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { ErrorNotice, MutationStatus } from "../admin/error-notice";
import { DateTime } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";

export { draftHref } from "./draft-href";

/**
 * The Workbench tab (KOBE-321, SK11): the caller's drafts in the active team and, for Builders and
 * Team admins, the drafts others shared with them; a new draft starts here.
 */
export function WorkbenchList() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const canCreate = access.permissions.includes("team.personal.create");
  return (
    <>
      {canCreate ? (
        <NewDraft teamId={teamId} />
      ) : (
        <p className="m-0 mb-4 text-sm text-console-muted">
          Your role in {access.team.name} doesn&apos;t allow writing skills.
        </p>
      )}
      <Drafts teamId={teamId} />
    </>
  );
}

function Drafts({ teamId }: { readonly teamId: string }) {
  const { state } = useResource(() => listDrafts(teamId));
  const [more, setMore] = useState<{ drafts: readonly DraftSummary[]; next: string | null }>({
    drafts: [],
    next: null,
  });
  const mutation = useMutation();
  if (state.status === "loading") return <p role="status">Loading drafts…</p>;
  if (state.status === "error") return <ErrorNotice error={state.error} />;
  const drafts = [...state.data.drafts, ...more.drafts];
  const next = more.drafts.length > 0 ? more.next : state.data.next;
  return (
    <Section title="Drafts" level={2}>
      {drafts.length === 0 ? (
        <EmptyState title="No drafts yet." />
      ) : (
        <Table caption="Drafts">
          <TableHead>
            <TableRow>
              <TableHeader>Draft</TableHeader>
              <TableHeader>Sharing</TableHeader>
              <TableHeader>Changed</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {drafts.map((d) => (
              <TableRow key={d.id}>
                <TableRowHeader>
                  <Link href={draftHref(d.id)}>{d.name}</Link>
                </TableRowHeader>
                <TableCell>
                  {d.mine ? (
                    d.shared ? (
                      <Badge tone="running">Shared with team builders</Badge>
                    ) : (
                      <Badge>Private</Badge>
                    )
                  ) : (
                    <Badge tone="accent">Shared with you</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <DateTime value={d.updatedAt} compact />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {next && (
        <div className="my-3">
          <Button
            disabled={mutation.pending}
            onClick={() =>
              mutation.run(async () => {
                const res = await listDrafts(teamId, next);
                if (res.ok)
                  setMore((m) => ({
                    drafts: [...m.drafts, ...res.data.drafts],
                    next: res.data.next,
                  }));
                return res;
              })
            }
          >
            Show more drafts
          </Button>
        </div>
      )}
      <MutationStatus error={mutation.error} notice={null} />
    </Section>
  );
}
