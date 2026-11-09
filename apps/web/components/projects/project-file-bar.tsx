"use client";

/**
 * The editor's project controls (Workspaces CM8, FP3; KOBE-581), above a file from `projects/`:
 * in a project the member checked out, its name, the "Changes" count, Commit…, Update and
 * Discard; in one they may edit but have not checked out, "Check out to edit"; for a reader, a
 * read-only notice. Nothing for files outside projects.
 */
import { useEffect, useState } from "react";
import { changesLabel } from "../../lib/projects/commits-api";
import { projectFileAccess, projectSlugOf } from "../../lib/projects/workspace";
import { ErrorNotice } from "../admin/error-notice";
import {
  CommitForm,
  DiscardConfirm,
  useProjectWork,
  useWorkDialogs,
  WORK_BUTTON,
  type ProjectRef,
} from "./project-work";
import { useWorkspaceProjects } from "./workspace-projects";

export function ProjectFileBar({
  path,
  version,
}: {
  readonly path: string;
  /** The file's loaded version: a save changes it, and the Changes count is read again. */
  readonly version?: string | undefined;
}) {
  const ctx = useWorkspaceProjects();
  const inProject = projectSlugOf(path) !== undefined;
  const ensure = ctx?.ensure;
  useEffect(() => {
    if (inProject) ensure?.();
  }, [inProject, ensure]);
  if (!ctx || !inProject) return null;
  if (ctx.status === "error") {
    return (
      <div role="alert" className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1">
          Your access to this project could not be read, so it opens read-only.
        </span>
        <button type="button" className={WORK_BUTTON} onClick={ctx.reload}>
          Try again
        </button>
      </div>
    );
  }
  if (ctx.status !== "ready") return null;
  const access = projectFileAccess(path, ctx.bySlug, ctx.checkedOut);
  if (access.kind === "none") return null;
  const ref: ProjectRef | undefined = access.project
    ? { id: access.project.id, name: access.project.name }
    : undefined;
  if (!ref) return null;
  return (
    <div
      role="region"
      aria-label={`Project ${ref.name}`}
      className="flex flex-col gap-1 border-b px-3 py-1.5 text-xs"
    >
      {access.kind === "checked_out" ? (
        <CheckedOut project={ref} version={version} />
      ) : access.kind === "editable" ? (
        <CheckOut project={ref} />
      ) : (
        <p className="text-muted-foreground m-0">
          <span className="text-foreground font-medium">{ref.name}</span>
          {access.project?.archivedAt
            ? " is archived: its files are read-only."
            : " · You can read this project, not change it."}
        </p>
      )}
    </div>
  );
}

function CheckOut({ project }: { readonly project: ProjectRef }) {
  const work = useProjectWork(project);
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
        <span className="text-muted-foreground">Read-only</span>
        <button
          type="button"
          className={WORK_BUTTON}
          disabled={work.busy}
          onClick={() => void work.checkout()}
        >
          Check out to edit
        </button>
      </div>
      {work.error && <ErrorNotice error={work.error} />}
    </>
  );
}

function CheckedOut({
  project,
  version,
}: {
  readonly project: ProjectRef;
  readonly version: string | undefined;
}) {
  const ctx = useWorkspaceProjects();
  const work = useProjectWork(project);
  const dialogs = useWorkDialogs(work);
  const [changes, setChanges] = useState<number | null>(null);
  const { notice } = work;
  useEffect(() => {
    let current = true;
    void ctx?.commits.checkoutState(project.id).then((res) => {
      if (current) setChanges(res.ok && res.data ? res.data.diff.length : null);
    });
    return () => {
      current = false;
    };
  }, [ctx, project.id, version, notice]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium">
          {project.name} <span className="text-muted-foreground font-normal">· editing</span>
        </span>
        <span>{changes === null ? "Changes" : `Changes: ${changesLabel(changes)}`}</span>
        <button type="button" className={WORK_BUTTON} disabled={work.busy} onClick={dialogs.commit}>
          Commit…
        </button>
        <button
          type="button"
          className={WORK_BUTTON}
          disabled={work.busy}
          onClick={() => void work.update()}
        >
          Update
        </button>
        <button
          type="button"
          className={WORK_BUTTON}
          disabled={work.busy}
          onClick={() => void dialogs.discard()}
        >
          Discard
        </button>
      </div>
      {dialogs.open?.kind === "commit" && (
        <CommitForm project={project} work={work} onDone={dialogs.close} onCancel={dialogs.close} />
      )}
      {dialogs.open?.kind === "discard" && (
        <DiscardConfirm
          project={project}
          changes={dialogs.open.changes}
          busy={work.busy}
          onConfirm={() => {
            dialogs.close();
            void work.discard();
          }}
          onCancel={dialogs.close}
        />
      )}
      {dialogs.open === null && work.error && <ErrorNotice error={work.error} />}
      {dialogs.open === null && (
        <p role="status" className="m-0">
          {work.notice}
        </p>
      )}
    </>
  );
}
