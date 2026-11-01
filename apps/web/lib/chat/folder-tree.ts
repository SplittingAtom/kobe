/**
 * The Threads panel's folder tree as data (KOBE-536, spec TF7): the team's folders ordered as
 * siblings (position, then name) under their parents, the built-in nodes around them (Current
 * with Archived folded under it, Deleted), the visible rows for a fold state, paths for notes,
 * and which folders a folder may move into without passing the depth limit (TF1).
 */
import { THREAD_FOLDER_MAX_DEPTH } from "@kobe/protocol";
import type { FolderView } from "./folders-api";

/** A node of the tree: a built-in one or a team folder. */
export type PanelNode =
  | { readonly kind: "current" }
  | { readonly kind: "archived" }
  | { readonly kind: "deleted" }
  | { readonly kind: "folder"; readonly id: string };

export const CURRENT: PanelNode = { kind: "current" };
export const ARCHIVED: PanelNode = { kind: "archived" };
export const DELETED: PanelNode = { kind: "deleted" };

export const nodeKey = (node: PanelNode): string =>
  node.kind === "folder" ? `folder:${node.id}` : node.kind;

export const sameNode = (a: PanelNode, b: PanelNode): boolean => nodeKey(a) === nodeKey(b);

/** A folder placed in the tree: its depth (1 = top level) and the folders under it. */
export interface PlacedFolder {
  readonly folder: FolderView;
  readonly depth: number;
  readonly childCount: number;
  /** Every folder below it, at any depth. */
  readonly descendantCount: number;
  /** Levels below it (0 = no subfolders): how deep its subtree reaches. */
  readonly height: number;
}

const bySibling = (a: FolderView, b: FolderView) =>
  a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The folders depth first, siblings in order. A folder whose parent is missing (deleted while
 * the list was read) is left out with its subtree: the next read settles it.
 */
export function placeFolders(folders: readonly FolderView[]): readonly PlacedFolder[] {
  const children = new Map<string | null, FolderView[]>();
  for (const f of folders) {
    const list = children.get(f.parentId) ?? [];
    list.push(f);
    children.set(f.parentId, list);
  }
  const out: PlacedFolder[] = [];
  const visit = (parentId: string | null, depth: number): { count: number; height: number } => {
    let count = 0;
    let height = 0;
    for (const folder of [...(children.get(parentId) ?? [])].sort(bySibling)) {
      const at = out.length;
      out.push({ folder, depth, childCount: 0, descendantCount: 0, height: 0 });
      // A cycle can't come from the server (its trigger refuses one); the depth guard is a fuse.
      const below = depth < 32 ? visit(folder.id, depth + 1) : { count: 0, height: 0 };
      out[at] = {
        folder,
        depth,
        childCount: children.get(folder.id)?.length ?? 0,
        descendantCount: below.count,
        height: below.height,
      };
      count += 1 + below.count;
      height = Math.max(height, below.height + 1);
    }
    return { count, height };
  };
  visit(null, 1);
  return out;
}

/** "A / Sub-folder": the folder's path by names, or null when it is not (or no longer) there. */
export function folderPath(folders: readonly FolderView[], id: string | null): string | null {
  if (id === null) return null;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names: string[] = [];
  let at = byId.get(id);
  while (at && names.length < 32) {
    names.unshift(at.name);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return names.length === 0 ? null : names.join(" / ");
}

/** One visible row of the tree. */
export interface TreeRow {
  readonly node: PanelNode;
  readonly label: string;
  /** aria-level: Current, Deleted and top-level folders are 1, Archived 2. */
  readonly level: number;
  /** Undefined for a node without children (no chevron). */
  readonly expanded: boolean | undefined;
  readonly count: number;
  readonly placed?: PlacedFolder;
}

export interface TreeCounts {
  readonly current: number;
  readonly archived: number;
  readonly deleted: number;
}

/**
 * The rows on screen: Current (its chevron shows Archived), then the folders whose ancestors are
 * all open, then Deleted.
 */
export function treeRows(
  placed: readonly PlacedFolder[],
  counts: TreeCounts,
  fold: { readonly currentOpen: boolean; readonly open: ReadonlySet<string> },
): readonly TreeRow[] {
  const rows: TreeRow[] = [
    {
      node: CURRENT,
      label: "Current",
      level: 1,
      expanded: fold.currentOpen,
      count: counts.current,
    },
  ];
  if (fold.currentOpen) {
    rows.push({
      node: ARCHIVED,
      label: "Archived",
      level: 2,
      expanded: undefined,
      count: counts.archived,
    });
  }
  // Depth first: a folder shows while every folder above it is open.
  let hiddenBelow = Number.POSITIVE_INFINITY;
  for (const p of placed) {
    if (p.depth > hiddenBelow) continue;
    hiddenBelow = Number.POSITIVE_INFINITY;
    const open = fold.open.has(p.folder.id);
    rows.push({
      node: { kind: "folder", id: p.folder.id },
      label: p.folder.name,
      level: p.depth,
      expanded: p.childCount > 0 ? open : undefined,
      count: p.folder.threads,
      placed: p,
    });
    if (!open) hiddenBelow = p.depth;
  }
  rows.push({
    node: DELETED,
    label: "Deleted",
    level: 1,
    expanded: undefined,
    count: counts.deleted,
  });
  return rows;
}

/** Whether a new folder can go inside `parent` (TF1: three levels counting the folder itself). */
export const canNestIn = (parent: PlacedFolder): boolean => parent.depth < THREAD_FOLDER_MAX_DEPTH;

/**
 * Where `moving` may go (TF7 Move to…): every other folder outside its own subtree whose depth
 * leaves room for the subtree, in tree order; "Top level" is the caller's (null), offered when it
 * is not there already.
 */
export function moveTargets(
  placed: readonly PlacedFolder[],
  moving: PlacedFolder,
): readonly PlacedFolder[] {
  const at = placed.findIndex((p) => p.folder.id === moving.folder.id);
  const subtree = new Set(
    placed.slice(at, at + 1 + moving.descendantCount).map((p) => p.folder.id),
  );
  return placed.filter(
    (p) =>
      !subtree.has(p.folder.id) &&
      p.folder.id !== moving.folder.parentId &&
      p.depth + 1 + moving.height <= THREAD_FOLDER_MAX_DEPTH,
  );
}

/** The Delete confirmation (TF7). */
export function deleteQuestion(placed: PlacedFolder): string {
  const n = placed.descendantCount;
  const name = `“${placed.folder.name}”`;
  if (n === 0) return `Delete ${name}? The threads in it go back to their owners' Current.`;
  const folders = n === 1 ? "its folder" : `its ${n} folders`;
  return `Delete ${name} and ${folders}? The threads in them go back to their owners' Current.`;
}
