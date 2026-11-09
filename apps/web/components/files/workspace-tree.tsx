"use client";

/**
 * The Files panel as the Workspace (Workspaces FP1; KOBE-581): the workspace's name on top, then
 * Projects (the projects mounted in the member's scratchspace, by name with the slug as hover
 * text, the role chip and the "editing" mark, and "All projects (n) →"), then My files (the
 * member's own files: uploads and the free area). Project names, roles and checkouts come from
 * the chat's {@link useWorkspaceProjects}; without it a project shows by its slug, read-only.
 */
import Link from "next/link";
import { useCallback, useEffect } from "react";
import { FolderKanbanIcon, LayersIcon } from "lucide-react";
import type { FileEntry } from "../../lib/files/api";
import {
  dropRefusal,
  effectiveRole,
  isProjectFolder,
  projectFileAccess,
  projectSlugOf,
  PROJECTS_FOLDER,
  ROLE_LABELS,
  type ProjectFileAccess,
} from "../../lib/projects/workspace";
import type { Project } from "../../lib/projects/api";
import { IconAction } from "../shell/icon-action";
import { useWorkspaceProjects } from "../projects/workspace-projects";
import type { RowDecoration } from "./file-tree";
import type { FileTree } from "./use-file-tree";

const CHIP = "text-muted-foreground shrink-0 rounded-full border px-1.5 text-[0.65rem] leading-4";
const EMPTY: ReadonlySet<string> = new Set();

type KnownAccess = Exclude<ProjectFileAccess, { kind: "none" }> & { readonly project: Project };

/** The projects' side of the tree: decorations, drop refusals, the editing set, the count. */
export function useProjectsInTree(tree: FileTree) {
  const ctx = useWorkspaceProjects();
  const hasProjects = tree.root.entries.some((e) => e.path === PROJECTS_FOLDER && e.type === "dir");
  const { expand, expanded } = tree;
  const ensure = ctx?.ensure;
  useEffect(() => {
    if (!hasProjects) return;
    ensure?.();
    // The Projects section always shows its projects: projects/ stays open.
    if (!expanded.has(PROJECTS_FOLDER)) expand(PROJECTS_FOLDER);
  }, [hasProjects, ensure, expand, expanded]);

  const checkedOut = ctx?.checkedOut ?? EMPTY;
  const bySlug = ctx?.bySlug;
  const accessOf = useCallback(
    (path: string): ProjectFileAccess => projectFileAccess(path, bySlug ?? new Map(), checkedOut),
    [bySlug, checkedOut],
  );

  const projectOf = (path: string): KnownAccess | undefined => {
    const access = accessOf(path);
    return access.kind !== "none" && access.project ? (access as KnownAccess) : undefined;
  };

  const decorate = (entry: FileEntry): RowDecoration | undefined => {
    if (!isProjectFolder(entry.path)) return undefined;
    const slug = projectSlugOf(entry.path) ?? entry.name;
    const project = bySlug?.get(slug);
    const editing = checkedOut.has(slug);
    const role = project ? ROLE_LABELS[effectiveRole(project)] : undefined;
    return {
      label: project?.name ?? slug,
      title: slug,
      description: [role, editing ? "editing" : "read-only"].filter(Boolean).join(", "),
      chips: (
        <>
          {role && <span className={CHIP}>{role}</span>}
          {editing && (
            <span className="text-foreground shrink-0 text-[0.65rem] leading-4 font-medium">
              editing <span aria-hidden>●</span>
            </span>
          )}
        </>
      ),
    };
  };

  return {
    checkedOut: ctx ? checkedOut : undefined,
    decorate,
    projectOf,
    dropRefusal: (folder: string) =>
      ctx === null || projectSlugOf(folder) === undefined
        ? undefined
        : dropRefusal(accessOf(folder)),
    total: ctx?.status === "ready" ? ctx.total : null,
    /** Whether "no projects" may be said: the listing is in, and the projects too if any. */
    ready: hasProjects
      ? tree.folders.get(PROJECTS_FOLDER)?.loading === false &&
        (ctx === null || ctx.status === "ready" || ctx.status === "error")
      : !tree.root.loading,
    failed: ctx?.status === "error",
    retry: () => ctx?.reload(),
  };
}

/** The tree's top row: the active workspace and Refresh files (KOBE-461). */
export function WorkspaceHeader({
  name,
  onRefresh,
}: {
  readonly name: string;
  readonly onRefresh: (() => void) | undefined;
}) {
  return (
    <div className="flex h-6.5 items-center gap-1 ps-0.5 text-xs font-medium">
      <LayersIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <h4 className="m-0 min-w-0 flex-1 truncate text-xs font-medium" title={name || undefined}>
        {name ? `Workspace: ${name}` : "Workspace"}
      </h4>
      {onRefresh && (
        <IconAction
          command="refresh-files"
          size="sm"
          side="right"
          variant="ghost"
          className="text-foreground shrink-0"
          onClick={onRefresh}
        />
      )}
    </div>
  );
}

/** The Projects row, with the way to every readable project (FP1, FP2). */
export function ProjectsHeader({ total }: { readonly total: number | null }) {
  return (
    <div className="flex h-6.5 items-center gap-1 ps-0.5 text-xs font-medium">
      <FolderKanbanIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Projects</span>
      <Link href="/me/projects" className="text-muted-foreground shrink-0 font-normal underline">
        {total === null ? "All projects →" : `All projects (${total}) →`}
      </Link>
    </div>
  );
}

export function NoProjects({ ready }: { readonly ready: boolean }) {
  if (!ready) return null;
  return (
    <p className="text-muted-foreground m-0 ps-0.5 text-xs">
      No projects in your files yet. A conversation in a project brings it here.
    </p>
  );
}
