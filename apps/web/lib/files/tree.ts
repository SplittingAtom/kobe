/**
 * The Files tree's pure parts (KOBE-304): which rows show for the loaded folders and the expanded
 * set, the remembered expansion (localStorage, per team in this browser, like the artifact tabs),
 * and the move rules the tree applies before asking the server (which decides; KOBE-304 ac-8).
 */
import { isMemberDropPath, WORKSPACE_DROP_FOLDER } from "@kobe/protocol";
import type { ApiError } from "../api/client";
import type { FileEntry } from "./api";
import { isReadOnlyPath, parentPath } from "./format";

/** Rows a folder shows before "Show more" (and how many more each press adds). */
export const FOLDER_PAGE_ROWS = 200;
/** Remembered expanded folders at most (the oldest are forgotten first). */
export const EXPANDED_MAX = 200;

/** One folder's listing as the tree holds it (the root is ""). */
export interface FolderLoad {
  readonly entries: readonly FileEntry[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  /** The last load failed; earlier entries stay on screen. */
  readonly error: ApiError | null;
}

export type TreeRow =
  | {
      readonly kind: "entry";
      readonly entry: FileEntry;
      /** 1 for the workspace's top level (aria-level). */
      readonly level: number;
      readonly posinset: number;
      readonly setsize: number;
      /** Folders only: whether its children show. */
      readonly expanded: boolean;
      /** Folders only: its listing is on its way. */
      readonly loading: boolean;
    }
  | {
      readonly kind: "more";
      readonly folder: string;
      readonly level: number;
      /** Entries loaded but not shown, or -1 when only the server has more. */
      readonly hidden: number;
    };

/** Agent-internal entries never show (the server leaves them out too). */
const hidden = (entry: FileEntry) => entry.path === ".kobe" || entry.path.startsWith(".kobe/");

/** The rows on screen, depth first: a folder's children follow it while it is expanded. */
export function visibleRows(
  folders: ReadonlyMap<string, FolderLoad>,
  expanded: ReadonlySet<string>,
  limits: ReadonlyMap<string, number>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (folder: string, level: number) => {
    const load = folders.get(folder);
    if (!load) return;
    const entries = load.entries.filter((e) => !hidden(e));
    const limit = limits.get(folder) ?? FOLDER_PAGE_ROWS;
    const shown = entries.slice(0, limit);
    shown.forEach((entry, i) => {
      const dir = entry.type === "dir";
      const open = dir && expanded.has(entry.path);
      const child = folders.get(entry.path);
      rows.push({
        kind: "entry",
        entry,
        level,
        posinset: i + 1,
        setsize: entries.length,
        expanded: open,
        loading: open && (child === undefined || (child.loading && child.entries.length === 0)),
      });
      if (open) walk(entry.path, level + 1);
    });
    if (entries.length > shown.length || load.nextCursor !== null) {
      rows.push({
        kind: "more",
        folder,
        level,
        hidden: entries.length > shown.length ? entries.length - shown.length : -1,
      });
    }
  };
  walk("", 1);
  return rows;
}

/** A row's stable key (and DOM id suffix). */
export const rowKey = (row: TreeRow): string =>
  row.kind === "entry" ? `e:${row.entry.path}` : `m:${row.folder}`;

export const joinPath = (folder: string, name: string): string =>
  folder === "" ? name : `${folder}/${name}`;

export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** `path` is `folder` itself or inside it. */
export const isWithin = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`);

/** Every ancestor folder of `path`, outermost first: `a/b/c` -> `a`, `a/b`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Where `path` is after `from` moved to `to`, or `path` itself when the move didn't touch it. */
export function movedPath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? `${to}${path.slice(from.length)}` : path;
}

/** Project mounts are read-only folders shown with a lock: `projects` and `projects/<name>`. */
export const isProjectMount = (path: string): boolean =>
  path === "projects" || (path.startsWith("projects/") && !path.slice(9).includes("/"));

/**
 * Whether `path` (a file or folder of type `type`) may be dropped into `folder` ("" = the top
 * level): not read-only on either side, not into itself or below, and somewhere new. Only a file
 * may go into uploads/ (it becomes a member's drop). The server checks again.
 */
export function canMoveInto(path: string, type: "file" | "dir", folder: string): boolean {
  if (isReadOnlyPath(path) || isWithin(folder, path) || parentPath(path) === folder) return false;
  const target = joinPath(folder, baseName(path));
  if (folder === WORKSPACE_DROP_FOLDER) return type === "file" && isMemberDropPath(target);
  return !isReadOnlyPath(target);
}

/** Whether files from the computer may be uploaded into `folder` (uploads/ takes drops). */
export const canUploadInto = (folder: string): boolean =>
  folder === "" || folder === WORKSPACE_DROP_FOLDER || !isReadOnlyPath(`${folder}/x`);

// ----------------------------------------------------------------------------- remembered state

const KEY_PREFIX = "kobe.filesTree:";

export const expandedKey = (teamId: string): string => `${KEY_PREFIX}${teamId}`;

/** The remembered expanded folders; anything unreadable is none. */
export function readExpanded(key: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return new Set();
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(
      value
        .filter((p): p is string => typeof p === "string" && p !== "" && p.length <= 1024)
        .slice(-EXPANDED_MAX),
    );
  } catch {
    return new Set(); // storage blocked or garbled
  }
}

export function writeExpanded(key: string, expanded: ReadonlySet<string>): void {
  try {
    if (expanded.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...expanded].slice(-EXPANDED_MAX)));
  } catch {
    // Storage blocked or full: the tree remembers for this page only.
  }
}
