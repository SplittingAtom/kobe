"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { ChatSession } from "../../lib/chat/session";
import type { FileEntry } from "../../lib/files/api";
import { mentionable } from "../../lib/chat/mentions";

/**
 * Wait after the last keystroke before asking the server: the file search is rate-limited
 * (300 per minute, KOBE-223, shared with the `@` picker) and the thread search reads the index.
 */
export const PALETTE_SEARCH_DEBOUNCE_MS = 250;
/** Shorter queries list actions only: one letter matches nearly every thread and file. */
export const PALETTE_SEARCH_MIN_CHARS = 2;
/** After a 429 the palette stops searching for this long. */
export const PALETTE_SEARCH_BACKOFF_MS = 10_000;
/** Rows per group: the palette is for jumping, the bar's search for browsing. */
export const PALETTE_RESULTS = 8;

export interface ThreadHit {
  readonly threadId: string;
  readonly title: string;
  readonly archived: boolean;
}

export interface PaletteSearch {
  readonly threads: readonly ThreadHit[];
  readonly files: readonly FileEntry[];
  readonly loading: boolean;
  readonly error: string | undefined;
}

interface Found {
  readonly query: string;
  readonly threads: readonly ThreadHit[];
  readonly files: readonly FileEntry[];
  readonly error: string | undefined;
}

const UNTITLED = "Untitled conversation";
const IDLE: PaletteSearch = { threads: [], files: [], loading: false, error: undefined };
const RATE_LIMITED = "Searching paused: too many searches. Try again in a few seconds.";

const failureOf = (error: ApiError | null) =>
  error === null
    ? undefined
    : error.status === 429
      ? RATE_LIMITED
      : `Some results could not be loaded: ${error.message}`;

/**
 * Thread titles (the bar's thread search, `GET /v1/threads?q=`) and workspace file names
 * (`GET /v1/workspace/files/search`) matching `query`, debounced, from 2 characters. A newer
 * query aborts the requests of the one before; answers are cached per query while the palette is
 * open; after a 429 nothing is asked for a while. Both are scoped server side to what the viewer
 * may open (KOBE-221, KOBE-223). While the next answers load no rows show, so Enter never opens
 * a result of an older query.
 */
export function usePaletteSearch(session: ChatSession, query: string): PaletteSearch {
  const q = query.trim();
  const searchable = q.length >= PALETTE_SEARCH_MIN_CHARS;
  const [found, setFound] = useState<Found | null>(null);
  const cache = useRef(new Map<string, Found>());
  const pausedUntil = useRef(0);
  useEffect(() => {
    if (!searchable) return;
    const cached = cache.current.get(q);
    if (cached) {
      setFound(cached);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      if (Date.now() < pausedUntil.current) {
        setFound({ query: q, threads: [], files: [], error: RATE_LIMITED });
        return;
      }
      void Promise.all([
        session.api.searchThreads(q, undefined, abort.signal),
        session.files.search(q, PALETTE_RESULTS, abort.signal),
      ]).then(([threads, files]) => {
        if (abort.signal.aborted) return;
        const failed = !threads.ok ? threads.error : !files.ok ? files.error : null;
        if (failed?.status === 429) pausedUntil.current = Date.now() + PALETTE_SEARCH_BACKOFF_MS;
        const next: Found = {
          query: q,
          threads: threads.ok
            ? threads.data.threads.slice(0, PALETTE_RESULTS).map((t) => ({
                threadId: t.threadId,
                title: t.title ?? UNTITLED,
                archived: t.archivedAt != null,
              }))
            : [],
          // Names with invisible characters are never offered (as in the `@` picker).
          files: files.ok ? files.data.entries.filter(mentionable) : [],
          error: failureOf(failed),
        };
        if (failed === null) cache.current.set(q, next);
        setFound(next);
      });
    }, PALETTE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [session, q, searchable]);
  if (!searchable) return IDLE;
  if (found === null || found.query !== q) return { ...IDLE, loading: true };
  return { threads: found.threads, files: found.files, loading: false, error: found.error };
}
