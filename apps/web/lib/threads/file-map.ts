/**
 * Joins the two reads of thread–file links (KOBE-612) into what the Threads panel shows: a
 * thread's files as line targets, the threads that used a file or anything in a folder, and the
 * words of the lists ("Files (3)", "Used in (2 threads)").
 */
import type { FileAccess, FileThreads, LinkedFile, ThreadFileLinks } from "./file-links";
import type { LineTarget } from "./line-model";

/** A thread's files that still exist, as line targets (deleted ones are listed, never drawn). */
export function filesOf(links: ThreadFileLinks | undefined): LineTarget[] {
  return (links?.files ?? [])
    .filter((f) => !f.deleted)
    .map((f) => ({ key: f.path, access: f.access }));
}

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

export interface ThreadUse {
  readonly threadId: string;
  readonly title: string | null;
  readonly access: FileAccess;
}

/**
 * The threads that used `path` (a file), or any file inside it (a folder): the file's own read
 * (`fileThreads`) joined with the loaded thread rows' links, write winning, newest read first.
 */
export function threadsUsing(
  path: string,
  dir: boolean,
  links: ReadonlyMap<string, ThreadFileLinks>,
  fileThreads: ReadonlyMap<string, FileThreads>,
): ThreadUse[] {
  const out = new Map<string, ThreadUse>();
  const add = (use: ThreadUse) => {
    const prev = out.get(use.threadId);
    if (!prev) out.set(use.threadId, use);
    else if (use.access === "write" && prev.access === "read") {
      out.set(use.threadId, { ...prev, access: "write" });
    }
  };
  const own = dir ? undefined : fileThreads.get(path);
  for (const t of own?.threads ?? []) {
    add({ threadId: t.threadId, title: t.title ?? null, access: t.access });
  }
  for (const l of links.values()) {
    for (const f of l.files) {
      if (!f.deleted && (dir ? within(f.path, path) && f.path !== path : f.path === path)) {
        add({ threadId: l.threadId, title: null, access: f.access });
      }
    }
  }
  return [...out.values()];
}

/** "Files (3)": every file the thread used, those the viewer may not name included. */
export function fileCount(links: ThreadFileLinks | undefined): number {
  return links === undefined ? 0 : links.files.length + links.hiddenCount;
}

/** "Used in (2 threads)" / "(1 thread)". */
export function usedInLabel(count: number): string {
  return `Used in (${count} ${count === 1 ? "thread" : "threads"})`;
}

/** "3 files you can't see" (TFM7): in a teammate's workspace or a project you can't read. */
export function hiddenFilesText(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"} you can't see`;
}

/** The last part of a path, for a list entry (the full path is its hover text). */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** How a file was used, for screen readers and the list: "written" or "read". */
export function accessWord(file: Pick<LinkedFile, "access">): string {
  return file.access === "write" ? "written" : "read";
}

/**
 * Threads that used a file but have no row in the list on screen, counted by where they are
 * ("2 in Archived, 1 elsewhere"); `placeOf` names a thread's node, or null when not loaded.
 */
export function elsewhereText(
  threadIds: readonly string[],
  placeOf: (threadId: string) => string | null,
): string {
  if (threadIds.length === 0) return "";
  const counts = new Map<string, number>();
  for (const id of threadIds) {
    const place = placeOf(id) ?? "";
    counts.set(place, (counts.get(place) ?? 0) + 1);
  }
  const named = [...counts].filter(([p]) => p !== "").map(([p, n]) => `${n} in ${p}`);
  const unknown = counts.get("") ?? 0;
  return [...named, ...(unknown > 0 ? [`${unknown} elsewhere`] : [])].join(", ");
}
