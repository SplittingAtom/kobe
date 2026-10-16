"use client";

import { useEffect, useState } from "react";
import type { ChatSession } from "../../lib/chat/session";
import type { FileEntry } from "../../lib/files/api";
import { mentionable } from "../../lib/chat/mentions";

/**
 * Wait after the last keystroke before asking the server: the file search is rate-limited
 * (300 per minute, KOBE-223) and the thread search reads the index; a word typed at speed is one
 * request of each.
 */
export const PALETTE_SEARCH_DEBOUNCE_MS = 250;
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

/**
 * Thread titles (the bar's thread search, `GET /v1/threads?q=`) and workspace file names
 * (`GET /v1/workspace/files/search`) matching `query`, debounced; only the newest query's answers
 * show. Both are scoped server side to what the viewer may open (KOBE-221, KOBE-223). A failed
 * search shows what the other found, with a note.
 */
export function usePaletteSearch(session: ChatSession, query: string): PaletteSearch {
  const q = query.trim();
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if (q === "") return;
    let live = true;
    const timer = setTimeout(() => {
      void Promise.all([
        session.api.searchThreads(q),
        session.files.search(q, PALETTE_RESULTS),
      ]).then(
        ([threads, files]) => {
          if (!live) return;
          const failed = !threads.ok ? threads.error : !files.ok ? files.error : null;
          setFound({
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
            error: failed ? `Some results could not be loaded: ${failed.message}` : undefined,
          });
        },
        () => {
          if (live) setFound({ query: q, threads: [], files: [], error: "Search failed." });
        },
      );
    }, PALETTE_SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [session, q]);
  if (q === "") return IDLE;
  if (found === null || found.query !== q) {
    // The last answers stay while the next ones load, so the list doesn't jump.
    return { ...(found ?? IDLE), loading: true, error: undefined };
  }
  return { threads: found.threads, files: found.files, loading: false, error: found.error };
}
