"use client";

import Link from "next/link";
import { useState } from "react";
import { SKILL_NAME_PATTERN as SKILL_NAME } from "@kobe/protocol";
import { createDraft, listDrafts, type DraftSummary } from "../../lib/skills/drafts-api";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
} from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { ErrorNotice, MutationStatus } from "../admin/error-notice";
import { DateTime } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";

export const draftHref = (id: string) => `/me/skills/drafts/${encodeURIComponent(id)}`;

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

function NewDraft({ teamId }: { readonly teamId: string }) {
  const [name, setName] = useState("");
  const [attempted, setAttempted] = useState(false);
  const mutation = useMutation();
  const invalid = !SKILL_NAME.test(name);
  return (
    <Section title="New draft" level={2}>
      <form
        noValidate
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setAttempted(true);
          if (invalid) return;
          await mutation.run(async () => {
            const res = await createDraft(teamId, name);
            if (res.ok) window.location.assign(draftHref(res.data.id));
            return res;
          });
        }}
      >
        <Field
          label="Skill name"
          hint="Lowercase letters, digits and hyphens, such as report-writer."
          error={attempted && invalid ? "Use lowercase letters, digits and hyphens." : undefined}
        >
          <TextInput type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          Start a draft
        </Button>
      </form>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </Section>
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
