"use client";

import { useMemo, useState } from "react";
import {
  createMemoryApi,
  describeMemoryError,
  type MemoryApi,
  type MemoryDocSummary,
  type MemoryTarget,
} from "../../lib/memory/api";
import { visible } from "../../lib/security/visible";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import {
  Button,
  EmptyState,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/console";
import { MemoryDocView } from "./memory-doc";

/** The list's heading: focus lands here when the open file is deleted. */
const FILES_HEADING = "memory-files";

/** Errors for people: the API's own wording, except where memory has better words. */
function friendly<T>(
  res: Awaited<ReturnType<MemoryApi["list"]>> | { ok: true; status: number; data: T },
) {
  return res.ok
    ? res
    : { ...res, error: { ...res.error, message: describeMemoryError(res.error) } };
}

/**
 * The memory files of one scope the person can see (`/v1/memory`, KOBE-155): list, open, edit,
 * delete, and version history. Everything shown is plain text (never HTML or markdown, so no
 * links or images from stored text), with hidden characters as visible escapes.
 */
export function MemoryPanel({
  teamId,
  target,
}: {
  readonly teamId: string;
  readonly target: MemoryTarget;
}) {
  const api = useMemo(() => createMemoryApi(teamId), [teamId]);
  const { state, reload } = useResource(async () => friendly(await api.list(target)));
  const [openId, setOpenId] = useState<string | null>(null);
  const mutation = useMutation();
  const title = target.scope === "project" ? "Project memory" : "My memory";

  return (
    <>
      <PageHeader
        title={title}
        description={`What your agents remembered${target.scope === "project" ? " for this project" : " about you"}. Edit or delete anything you do not want kept. Agents treat this text as untrusted notes.`}
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Section id={FILES_HEADING} title="Files">
        <ResourceView state={state} label="memory">
          {(data) =>
            data.docs.length === 0 ? (
              <EmptyState title="No memory files yet.">
                Your agents add some when you ask them to remember something.
              </EmptyState>
            ) : (
              <DocList docs={data.docs} openId={openId} onOpen={setOpenId} />
            )
          }
        </ResourceView>
      </Section>
      {openId !== null && (
        <MemoryDocView
          key={openId}
          api={api}
          id={openId}
          target={target}
          mutation={mutation}
          onChanged={reload}
          onGone={() => {
            setOpenId(null);
            reload();
            document.getElementById(FILES_HEADING)?.focus();
          }}
        />
      )}
    </>
  );
}

function DocList({
  docs,
  openId,
  onOpen,
}: {
  readonly docs: readonly MemoryDocSummary[];
  readonly openId: string | null;
  readonly onOpen: (id: string) => void;
}) {
  return (
    <Table caption="Memory files" hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>File</TableHeader>
          <TableHeader numeric>Size</TableHeader>
          <TableHeader>Updated</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {docs.map((d) => (
          <TableRow
            key={d.id}
            aria-current={d.id === openId ? "true" : undefined}
            className="aria-[current=true]:bg-console-panel"
          >
            <TableCell>
              <Button
                variant="ghost"
                size="sm"
                className="font-mono"
                aria-label={`Open ${visible(d.path)}`}
                onClick={() => onOpen(d.id)}
              >
                {visible(d.path)}
              </Button>
            </TableCell>
            <TableCell numeric>{d.sizeBytes} bytes</TableCell>
            <TableCell>
              <DateTime value={d.updatedAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
