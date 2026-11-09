"use client";

/**
 * A project's History tab (Workspaces CM7, CM8; KOBE-581): commits newest first (seq, author,
 * message, counts, time) with "Show older"; a commit opens its diff to the parent (added,
 * modified, deleted, with sizes) and its files, each downloadable as it was then; Revert writes
 * a new commit equal to that tree (editors and up; history is never rewritten).
 */
import { useState } from "react";
import type { ApiError } from "../../lib/api/client";
import { formatBytes } from "../../lib/files/format";
import { saveBytes } from "../../lib/files/save";
import { describeProjectError, type Project } from "../../lib/projects/api";
import type {
  ProjectCommit,
  ProjectCommitDetail,
  ProjectDiffEntry,
} from "../../lib/projects/commits-api";
import { ErrorNotice, MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
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
  eventTrigger,
  useConfirm,
} from "../ui/console";
import { useCommitsApi, useRoster } from "./use-projects";

const CHANGE_LABEL = { added: "Added", modified: "Modified", deleted: "Deleted" } as const;

function sizeOf(entry: ProjectDiffEntry): string {
  if (entry.change === "added") return formatBytes(entry.sizeBytes);
  if (entry.change === "deleted") return formatBytes(entry.previousSizeBytes);
  return `${formatBytes(entry.previousSizeBytes)} → ${formatBytes(entry.sizeBytes)}`;
}

export function ProjectHistory({
  project,
  canRevert,
}: {
  readonly project: Project;
  readonly canRevert: boolean;
}) {
  const api = useCommitsApi();
  const roster = useRoster();
  const [before, setBefore] = useState<number | null>(null);
  const [older, setOlder] = useState<readonly ProjectCommit[]>([]);
  const { state, reload } = useResource(() => api.history(project.id));
  const [open, setOpen] = useState<number | null>(null);
  const [olderError, setOlderError] = useState<ApiError | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const author = (c: ProjectCommit) =>
    c.authorKind === "agent"
      ? `Agent for ${roster.nameOf(c.authorUserId)}`
      : roster.nameOf(c.authorUserId);

  async function more(next: number) {
    if (loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    const res = await api.history(project.id, next);
    setLoadingOlder(false);
    if (!res.ok) return setOlderError(res.error);
    setOlder((prev) => {
      const seen = new Set(prev.map((c) => c.id));
      return [...prev, ...res.data.commits.filter((c) => !seen.has(c.id))];
    });
    setBefore(res.data.nextBefore ?? -1);
  }

  return (
    <Section title="History" description="Every commit of the project's files, newest first.">
      <ResourceView state={state} label="the history">
        {(page) => {
          const firstIds = new Set(page.commits.map((c) => c.id));
          const commits = [...page.commits, ...older.filter((c) => !firstIds.has(c.id))];
          const next = before === null ? page.nextBefore : before === -1 ? null : before;
          if (commits.length === 0) return <EmptyState title="No commits yet." />;
          return (
            <>
              <Table caption="Commits" hideCaption>
                <TableHead>
                  <TableRow>
                    <TableHeader>Commit</TableHeader>
                    <TableHeader>Message</TableHeader>
                    <TableHeader>Author</TableHeader>
                    <TableHeader numeric>Files</TableHeader>
                    <TableHeader numeric>Size</TableHeader>
                    <TableHeader>When</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {commits.map((c) => (
                    <TableRow key={c.id}>
                      <TableRowHeader>
                        <Button
                          size="sm"
                          aria-expanded={open === c.seq}
                          onClick={() => setOpen(open === c.seq ? null : c.seq)}
                        >
                          #{c.seq}
                          <span className="sr-only"> changes</span>
                        </Button>
                      </TableRowHeader>
                      <TableCell className="break-words">{c.message}</TableCell>
                      <TableCell>{author(c)}</TableCell>
                      <TableCell numeric>{c.fileCount}</TableCell>
                      <TableCell numeric>{formatBytes(c.bytes)}</TableCell>
                      <TableCell>
                        <DateTime value={c.createdAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {olderError && <ErrorNotice error={olderError} />}
              {next !== null && (
                <Button className="mt-2" disabled={loadingOlder} onClick={() => void more(next)}>
                  Show older commits
                </Button>
              )}
              {open !== null && (
                <CommitView
                  key={open}
                  project={project}
                  seq={open}
                  canRevert={canRevert && project.archivedAt === null}
                  onReverted={() => {
                    setOpen(null);
                    setOlder([]);
                    setBefore(null);
                    reload();
                  }}
                />
              )}
            </>
          );
        }}
      </ResourceView>
    </Section>
  );
}

function CommitView({
  project,
  seq,
  canRevert,
  onReverted,
}: {
  readonly project: Project;
  readonly seq: number;
  readonly canRevert: boolean;
  onReverted(): void;
}) {
  const api = useCommitsApi();
  const { state } = useResource(() => api.commitDetail(project.id, seq));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();

  async function download(path: string) {
    await mutation.run(
      () => api.downloadAt(project.id, seq, path),
      (bytes) => {
        saveBytes(path.slice(path.lastIndexOf("/") + 1), bytes);
        return `Downloaded ${path} as of #${seq}.`;
      },
    );
  }

  async function revert(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Revert ${project.name} to #${seq}?`,
        description: `A new commit makes the files as they were at #${seq}. Nothing in the history is removed.`,
        confirmLabel: "Revert",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      async () => {
        const res = await api.revert(project.id, seq);
        return res.ok
          ? res
          : {
              ok: false as const,
              error: { ...res.error, message: describeProjectError(res.error) },
            };
      },
      (r) => (r.status === "committed" ? `Reverted to #${seq} as #${r.seq}.` : "Nothing changed."),
    );
    if (done) onReverted();
  }

  return (
    <Section title={`Commit #${seq}`} level={3}>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="the commit">
        {(detail) => (
          <CommitDetailView
            detail={detail}
            pending={mutation.pending}
            onDownload={(path) => void download(path)}
          />
        )}
      </ResourceView>
      {canRevert && (
        <Button
          className="mt-2"
          disabled={mutation.pending}
          onClick={(e) => void revert(eventTrigger(e))}
        >
          Revert to #{seq}
        </Button>
      )}
      {confirmDialog}
    </Section>
  );
}

function CommitDetailView({
  detail,
  pending,
  onDownload,
}: {
  readonly detail: ProjectCommitDetail;
  readonly pending: boolean;
  onDownload(path: string): void;
}) {
  return (
    <>
      <p className="m-0 mb-2 text-sm">{detail.commit.message}</p>
      {detail.diff.length === 0 ? (
        <p className="m-0 text-sm text-console-muted">No file changed in this commit.</p>
      ) : (
        <Table caption="Changes in this commit">
          <TableHead>
            <TableRow>
              <TableHeader>File</TableHeader>
              <TableHeader>Change</TableHeader>
              <TableHeader numeric>Size</TableHeader>
              <TableHeader>
                <span className="sr-only">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {detail.diff.map((d) => (
              <TableRow key={`${d.change}:${d.path}`}>
                <TableRowHeader className="break-all">{d.path}</TableRowHeader>
                <TableCell>{CHANGE_LABEL[d.change]}</TableCell>
                <TableCell numeric>{sizeOf(d)}</TableCell>
                <TableCell>
                  {d.change !== "deleted" && (
                    <Button size="sm" disabled={pending} onClick={() => onDownload(d.path)}>
                      Download<span className="sr-only"> {d.path}</span>
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <details className="mt-2 text-sm">
        <summary>All {detail.tree.length} files at this commit</summary>
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
          {detail.tree.map((f) => (
            <li key={f.path} className="flex flex-wrap items-center gap-2">
              <span className="break-all">{f.path}</span>
              <span className="text-console-muted">{formatBytes(f.sizeBytes)}</span>
              <Button size="sm" disabled={pending} onClick={() => onDownload(f.path)}>
                Download<span className="sr-only"> {f.path} at this commit</span>
              </Button>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
