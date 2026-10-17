"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry, FilesApi } from "../../lib/files/api";
import {
  ancestorsOf,
  FOLDER_PAGE_ROWS,
  isWithin,
  movedPath,
  readExpanded,
  visibleRows,
  writeExpanded,
  type FolderLoad,
  type TreeRow,
} from "../../lib/files/tree";

export interface FileTree {
  readonly rows: readonly TreeRow[];
  readonly root: FolderLoad;
  /** Folders whose last load failed (the root's error is `root.error`). */
  readonly errors: readonly { readonly folder: string; readonly load: FolderLoad }[];
  readonly expanded: ReadonlySet<string>;
  /** Every folder listed so far, for "Move to…". */
  readonly knownFolders: readonly FileEntry[];
  toggle(path: string): void;
  expand(path: string): void;
  collapse(path: string): void;
  /** Shows the next rows of a folder, fetching its next page when they are all shown. */
  showMore(folder: string): void;
  /** Lists every folder on screen again (the sandbox woke, Refresh). */
  reloadAll(): void;
  /** Lists `folder` again and expands it and its ancestors (an upload, a move landed there). */
  reveal(folder: string): void;
  /** After a move: expanded folders inside `from` follow it to `to`. */
  moved(from: string, to: string): void;
}

const EMPTY: FolderLoad = { entries: [], nextCursor: null, loading: true, error: null };

/**
 * The Files tree's state (KOBE-304): one listing per folder, loaded lazily through the listing
 * API when the folder first opens; expanded folders remembered in `storageKey`. A reload keeps the
 * previous entries until the new ones arrive (the "last synced" view while the sandbox wakes); a
 * folder that is gone (404) closes and is forgotten.
 */
export function useFileTree(api: FilesApi, storageKey: string): FileTree {
  const [folders, setFolders] = useState<ReadonlyMap<string, FolderLoad>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => readExpanded(storageKey));
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(new Map());
  const latest = useRef({ folders, expanded });
  latest.current = { folders, expanded };
  const seq = useRef(new Map<string, number>());

  useEffect(() => writeExpanded(storageKey, expanded), [storageKey, expanded]);

  const patch = useCallback((folder: string, change: (prev: FolderLoad) => FolderLoad | null) => {
    setFolders((prev) => {
      const next = new Map(prev);
      const value = change(prev.get(folder) ?? EMPTY);
      if (value === null) next.delete(folder);
      else next.set(folder, value);
      return next;
    });
  }, []);

  const load = useCallback(
    (folder: string, cursor?: string) => {
      const n = (seq.current.get(folder) ?? 0) + 1;
      seq.current.set(folder, n);
      patch(folder, (prev) => ({ ...prev, loading: true }));
      void api.list(folder, cursor).then((res) => {
        if (seq.current.get(folder) !== n) return; // a newer load of this folder won
        if (!res.ok && res.error.status === 404 && folder !== "") {
          // The folder is gone (moved, deleted, emptied): close it and forget it.
          patch(folder, () => null);
          setExpanded((prev) => new Set([...prev].filter((p) => !isWithin(p, folder))));
          return;
        }
        patch(folder, (prev) =>
          res.ok
            ? {
                entries: cursor ? [...prev.entries, ...res.data.entries] : res.data.entries,
                nextCursor: res.data.nextCursor ?? null,
                loading: false,
                error: null,
              }
            : { ...prev, loading: false, error: res.error },
        );
      });
    },
    [api, patch],
  );

  /** Folders whose rows are on screen: the root and every expanded folder whose parents are. */
  const visibleFolders = useCallback((open: ReadonlySet<string>) => {
    const out = [""];
    for (const path of open) {
      if (ancestorsOf(path).every((a) => open.has(a))) out.push(path);
    }
    return out;
  }, []);

  // The first listing, and lazily each expanded folder the first time it shows.
  useEffect(() => {
    for (const folder of visibleFolders(expanded)) {
      if (!latest.current.folders.has(folder)) load(folder);
    }
  }, [expanded, load, visibleFolders]);

  const expand = useCallback((path: string) => {
    setExpanded((prev) => (prev.has(path) ? prev : new Set([...prev, path])));
  }, []);
  const collapse = useCallback((path: string) => {
    setExpanded((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);
  const toggle = useCallback(
    (path: string) => (latest.current.expanded.has(path) ? collapse(path) : expand(path)),
    [collapse, expand],
  );

  const showMore = useCallback(
    (folder: string) => {
      const loadOf = latest.current.folders.get(folder);
      const limit = (limits.get(folder) ?? FOLDER_PAGE_ROWS) + FOLDER_PAGE_ROWS;
      setLimits((prev) => new Map(prev).set(folder, limit));
      if (
        loadOf &&
        limit > loadOf.entries.length &&
        loadOf.nextCursor !== null &&
        !loadOf.loading
      ) {
        load(folder, loadOf.nextCursor);
      }
    },
    [limits, load],
  );

  const reloadAll = useCallback(() => {
    for (const folder of visibleFolders(latest.current.expanded)) load(folder);
  }, [load, visibleFolders]);

  const reveal = useCallback(
    (folder: string) => {
      if (folder !== "") {
        setExpanded((prev) => new Set([...prev, ...ancestorsOf(folder), folder]));
      }
      load(folder);
    },
    [load],
  );

  const moved = useCallback((from: string, to: string) => {
    setExpanded((prev) => new Set([...prev].map((p) => movedPath(p, from, to))));
    setFolders((prev) => new Map([...prev].filter(([p]) => p === "" || !isWithin(p, from))));
  }, []);

  const rows = useMemo(() => visibleRows(folders, expanded, limits), [folders, expanded, limits]);
  const errors = useMemo(
    () =>
      [...folders]
        .filter(([folder, l]) => folder !== "" && l.error !== null)
        .map(([folder, l]) => ({ folder, load: l })),
    [folders],
  );
  const knownFolders = useMemo(
    () => [...folders.values()].flatMap((l) => l.entries.filter((e) => e.type === "dir")),
    [folders],
  );
  return {
    rows,
    root: folders.get("") ?? EMPTY,
    errors,
    expanded,
    knownFolders,
    toggle,
    expand,
    collapse,
    showMore,
    reloadAll,
    reveal,
    moved,
  };
}
