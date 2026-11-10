"use client";

/**
 * The Files panel as the Workspace (Workspaces FP1; KOBE-581): the workspace's name on top, then
 * Projects (the projects mounted in the member's scratchspace, by name with the slug as hover
 * text, the role chip and the "editing" mark, and "All projects (n) →"), then My files (the
 * member's own files: uploads and the free area). Project names, roles and checkouts come from
 * the chat's {@link useWorkspaceProjects}; without it a project shows by its slug, read-only.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderKanbanIcon, LayersIcon, RefreshCwIcon } from "lucide-react";
import type { FileEntry } from "../../lib/files/api";
import { isWithin, splitProjectRows, visibleRows } from "../../lib/files/tree";
import {
  NOT_IN_CONVERSATION,
  PROJECTS_FILTER_AT,
  shapeProjectRows,
  unmountedDragRefusal,
  unmountedProjectEntry,
} from "../../lib/projects/files-panel";
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

const NO_PROJECTS_ENTRY: FileEntry = {
  name: PROJECTS_FOLDER,
  path: PROJECTS_FOLDER,
  type: "dir",
  sizeBytes: null,
  mtime: "",
  source: "synced",
  area: "projects",
};

/**
 * The projects' side of the tree: every non-archived project as a row (FP1), the active one
 * first and the rest greyed (FP2), decorations, drop and mention refusals, the editing set, the
 * count and the scale rules (FP5). A project that is not mounted is a synthetic row whose folders
 * list from its head (`useProjectHeads`). `activeProjectId` is the conversation on screen's
 * project, or the draft's (FP2).
 */
export function useProjectsInTree(
  tree: FileTree,
  activeProjectId: string | null = null,
  showEditing = true,
) {
  const ctx = useWorkspaceProjects();
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const { expand, expanded } = tree;
  const ensure = ctx?.ensure;
  const hasProjectsFolder = tree.root.entries.some(
    (e) => e.path === PROJECTS_FOLDER && e.type === "dir",
  );
  // Open: projects/ when the member's files have one (as before), and when a project of it
  // that is not mounted is open (its folders list under projects/, from the head).
  const hasCtx = ctx !== null;
  const opensUnmounted =
    hasCtx && [...expanded].some((p) => p !== PROJECTS_FOLDER && isWithin(p, PROJECTS_FOLDER));
  const keepOpen = hasProjectsFolder || opensUnmounted;
  // Once: a failed read is retried by Try again, not by every re-render.
  useEffect(() => {
    if (hasCtx) ensure?.();
  }, [hasCtx, ensure]);
  useEffect(() => {
    if (keepOpen && !expanded.has(PROJECTS_FOLDER)) expand(PROJECTS_FOLDER);
  }, [keepOpen, expand, expanded]);

  const checkedOut = ctx?.checkedOut ?? EMPTY;
  const bySlug = ctx?.bySlug;
  const accessOf = useCallback(
    (path: string): ProjectFileAccess => projectFileAccess(path, bySlug ?? new Map(), checkedOut),
    [bySlug, checkedOut],
  );
  const activeSlug =
    activeProjectId === null || !bySlug
      ? undefined
      : [...bySlug.values()].find((p) => p.id === activeProjectId)?.slug;

  const mounted = hasProjectsFolder ? tree.folders.get(PROJECTS_FOLDER) : undefined;
  /** What the member's files hold under projects/ is known (none, when there is no such folder). */
  const mountedKnown = hasProjectsFolder ? mounted?.loading === false : !tree.root.loading;
  const mountedSlugs = useMemo(
    () => new Set((mounted?.entries ?? []).map((e) => e.name)),
    [mounted],
  );
  /** A listed project with no folder in the member's files: browsed from its head. */
  const isUnmounted = (slug: string): boolean =>
    mountedKnown && !mountedSlugs.has(slug) && bySlug?.get(slug) !== undefined;

  const shaped = useMemo(() => {
    const live = [...(bySlug?.values() ?? [])].filter((p) => p.archivedAt === null);
    const synthetic = live
      .filter((p) => !mountedSlugs.has(p.slug))
      .map((p) => unmountedProjectEntry(p));
    const folders = new Map(tree.folders);
    folders.set("", {
      entries: [NO_PROJECTS_ENTRY],
      nextCursor: null,
      loading: false,
      error: null,
    });
    folders.set(PROJECTS_FOLDER, {
      entries: [...(mounted?.entries ?? []), ...synthetic],
      nextCursor: null,
      loading: !mountedKnown,
      error: mounted?.error ?? null,
    });
    const rows = splitProjectRows(
      visibleRows(folders, new Set([...tree.expanded, PROJECTS_FOLDER]), tree.limits),
    ).projects;
    return shapeProjectRows(rows, {
      projects: bySlug ?? new Map(),
      activeSlug,
      checkedOut,
      filter,
      showAll,
    });
  }, [
    tree.folders,
    tree.expanded,
    tree.limits,
    mounted,
    mountedSlugs,
    bySlug,
    activeSlug,
    checkedOut,
    filter,
    showAll,
  ]);

  const projectOf = (path: string): KnownAccess | undefined => {
    const access = accessOf(path);
    return access.kind !== "none" && access.project ? (access as KnownAccess) : undefined;
  };

  const decorate = (entry: FileEntry): RowDecoration | undefined => {
    if (!isProjectFolder(entry.path)) return undefined;
    const slug = projectSlugOf(entry.path) ?? entry.name;
    const project = bySlug?.get(slug);
    // A private conversation (no project, or shared with no one) shows no "editing" mark (FP3 as
    // amended 2026-11-10); the checkout itself is unchanged.
    const checked = checkedOut.has(slug);
    const editing = showEditing && checked;
    const active = project !== undefined && project.id === activeProjectId;
    const greyed = !active;
    const role = project ? ROLE_LABELS[effectiveRole(project)] : undefined;
    return {
      label: project?.name ?? slug,
      title: slug,
      greyed,
      active,
      description: [
        greyed ? NOT_IN_CONVERSATION : undefined,
        role,
        editing ? "editing" : checked ? undefined : "read-only",
      ]
        .filter(Boolean)
        .join(", "),
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
    rows: shaped.rows,
    hidden: shaped.hidden,
    filter,
    setFilter,
    showAll,
    setShowAll,
    all: shaped.total,
    showFilter: shaped.total >= PROJECTS_FILTER_AT,
    activeSlug,
    isUnmounted,
    decorate,
    projectOf,
    /** Why the file at `path` cannot go into a message: its project is not mounted (FP4). */
    mentionRefusal: (path: string): string | undefined => {
      const slug = projectSlugOf(path);
      if (slug === undefined || path === `${PROJECTS_FOLDER}/${slug}` || !isUnmounted(slug)) {
        return undefined;
      }
      return unmountedDragRefusal(bySlug?.get(slug)?.name ?? slug);
    },
    dropRefusal: (folder: string) =>
      ctx === null || projectSlugOf(folder) === undefined
        ? undefined
        : dropRefusal(accessOf(folder)),
    total: ctx?.status === "ready" ? ctx.total : null,
    /** Whether "no projects" may be said: the listing is in, and the projects too if any. */
    ready: mountedKnown && (ctx === null || ctx.status === "ready" || ctx.status === "error"),
    failed: ctx?.status === "error",
    retry: () => ctx?.reload(),
  };
}

/**
 * The tree's top row: the active workspace and Refresh files (KOBE-461). `syncing` (KOBE-599):
 * Refresh is waiting for the sandbox's push; the button is busy and does nothing meanwhile.
 */
export function WorkspaceHeader({
  name,
  onRefresh,
  syncing = false,
}: {
  readonly name: string;
  readonly onRefresh: (() => void) | undefined;
  readonly syncing?: boolean | undefined;
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
          aria-disabled={syncing}
          aria-busy={syncing}
          description={syncing ? "Syncing your sandbox…" : undefined}
          onClick={syncing ? undefined : onRefresh}
        >
          {syncing ? <RefreshCwIcon aria-hidden className="size-4 animate-spin" /> : undefined}
        </IconAction>
      )}
    </div>
  );
}

/** The Projects row, with the way to the projects page, where they are made and managed (FP1). */
export function ProjectsHeader() {
  return (
    <div className="flex h-6.5 items-center gap-1 ps-0.5 text-xs font-medium">
      <FolderKanbanIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Projects</span>
      <Link href="/me/projects" className="text-muted-foreground shrink-0 font-normal underline">
        Manage projects →
      </Link>
    </div>
  );
}

/** The filter field (20 or more projects) above the list, and Show all under a capped one (FP5). */
export function ProjectsFilter({
  value,
  onChange,
}: {
  readonly value: string;
  onChange(value: string): void;
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      placeholder="Filter projects"
      aria-label="Filter projects"
      className="border-input bg-background h-6.5 w-full rounded-md border px-2 text-xs"
    />
  );
}

export function ShowAllProjects({
  total,
  onShow,
}: {
  readonly total: number | null;
  onShow(): void;
}) {
  return (
    <button
      type="button"
      className="text-muted-foreground ps-0.5 text-start text-xs underline"
      onClick={onShow}
    >
      {total === null ? "Show all" : `Show all (${total})`}
    </button>
  );
}

export function NoProjects({
  ready,
  filtered = false,
}: {
  readonly ready: boolean;
  readonly filtered?: boolean;
}) {
  if (!ready) return null;
  return (
    <p className="text-muted-foreground m-0 ps-0.5 text-xs">
      {filtered
        ? "No project matches."
        : "No projects yet. Create one on the projects page, then start a conversation in it."}
    </p>
  );
}
