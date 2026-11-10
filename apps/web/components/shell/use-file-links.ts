"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  batches,
  FILE_LINKS_MAX_THREADS,
  FILE_THREADS_MAX_PATHS,
  type FileLinksApi,
  type FileThreads,
  type ThreadFileLinks,
} from "../../lib/threads/file-links";

/**
 * Reads keyed values once each, in batches, as they come on screen (KOBE-612): the thread rows'
 * links or the tree's files' threads are fetched before any hover, so a hover never waits on the
 * network. A failed batch is left unknown (no lines, no count) and asked again when its keys show
 * again after a change of the list.
 */
function useBatchedReads<T>(
  keys: readonly string[],
  size: number,
  read: ((batch: readonly string[]) => Promise<readonly T[] | null>) | null,
  keyOf: (value: T) => string,
): ReadonlyMap<string, T> {
  const [known, setKnown] = useState<ReadonlyMap<string, T>>(new Map());
  const asked = useRef(new Set<string>());
  const keyed = keys.join("\n");
  useEffect(() => {
    if (read === null) return;
    const wanted = [...new Set(keyed === "" ? [] : keyed.split("\n"))].filter(
      (k) => !asked.current.has(k),
    );
    for (const batch of batches(wanted, size)) {
      for (const k of batch) asked.current.add(k);
      void read(batch).then((values) => {
        if (values === null) {
          for (const k of batch) asked.current.delete(k);
          return;
        }
        setKnown((prev) => {
          const next = new Map(prev);
          for (const v of values) next.set(keyOf(v), v);
          return next;
        });
      });
    }
  }, [keyed, size, read, keyOf]);
  return known;
}

const threadKey = (l: ThreadFileLinks) => l.threadId;
const pathKey = (f: FileThreads) => f.path;

/** The links of the thread rows on screen, by thread id. */
export function useThreadLinks(
  api: FileLinksApi | null,
  threadIds: readonly string[],
): ReadonlyMap<string, ThreadFileLinks> {
  const read = useMemo(
    () =>
      api === null
        ? null
        : async (batch: readonly string[]) => {
            const res = await api.threadFileLinks(batch);
            return res.ok ? res.data : null;
          },
    [api],
  );
  return useBatchedReads(threadIds, FILE_LINKS_MAX_THREADS, read, threadKey);
}

/** The threads of the files on screen, by path. */
export function useFileThreads(
  api: FileLinksApi | null,
  paths: readonly string[],
): ReadonlyMap<string, FileThreads> {
  const read = useMemo(
    () =>
      api === null
        ? null
        : async (batch: readonly string[]) => {
            const res = await api.fileThreads(batch);
            return res.ok ? res.data : null;
          },
    [api],
  );
  return useBatchedReads(paths, FILE_THREADS_MAX_PATHS, read, pathKey);
}

/**
 * The thread ids with a row in `ref`'s element (the panel's thread column: the chosen node's
 * groups, Archived, Trash or the search hits), followed as rows come and go.
 */
export function useShownThreads(ref: { readonly current: HTMLElement | null }): readonly string[] {
  const [ids, setIds] = useState<readonly string[]>([]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame: number | null = null;
    const scan = () => {
      frame = null;
      const found = [
        ...new Set(
          [...el.querySelectorAll<HTMLElement>("[data-kobe-thread]")].flatMap((li) => {
            const id = li.dataset["kobeThread"];
            return id ? [id] : [];
          }),
        ),
      ];
      setIds((prev) => (prev.join("\n") === found.join("\n") ? prev : found));
    };
    scan();
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => {
      if (frame === null) frame = requestAnimationFrame(scan);
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-kobe-thread"],
    });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ref]);
  return ids;
}
