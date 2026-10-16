import { MEMORY_RECALL_MAX_FILES, type MemoryScope, type RecallInput } from "@kobe/protocol";
import type { BlobStore } from "../retention/blobs.js";
import { readVersionContent, type ListedDoc } from "./store.js";

/**
 * The object-store half of `recall` (KOBE-240). It gets docs already listed and authorized in the
 * caller's committed team transaction and reads their bodies by the current version's
 * server-written key from that listing (never a key or path the sandbox names), so no
 * transaction or pooled connection is held while up to 200 objects are fetched.
 *
 * Race with changes after the listing committed: a doc deleted, a switch turned off or a
 * membership removed in that gap may still be answered once, as if the read had finished just
 * before the change (versions are immutable, so the bytes are exactly the listed version's). A
 * listed object that is gone (the doc got a new version and the old object was purged, or Undo)
 * is re-resolved once through {@link SearchReader.reresolve}, which re-runs the caller's checks
 * in a short team transaction; it is skipped only if it is still unreadable.
 */

/** Most docs a search looks at (the answer holds at most 20 files). */
export const SEARCH_DOCS_MAX = 200;
/** Cap on the content one `recall` answer carries. */
export const READ_CONTENT_MAX_BYTES = 256 * 1024;
/** Object reads in flight at once; matches are still taken strictly in path order. */
export const SEARCH_READ_CONCURRENCY = 8;

export type FileOut = { scope: MemoryScope; path: string; content?: string; version: number };
export interface Found {
  readonly files: FileOut[];
  readonly truncated: boolean;
}

/** The doc's current version and object key now, if the caller may still read it. */
export type Reresolve = (
  doc: ListedDoc,
) => Promise<{ readonly currentVersion: number; readonly blobRef: string } | undefined>;

export interface SearchReader {
  readonly blobs: BlobStore;
  readonly reresolve: Reresolve;
}

interface Body {
  readonly content: string;
  readonly version: number;
}

const bodyOf = (content: string | null, version: number): Body | null =>
  content === null ? null : { content, version };

/** Second chance for a listed doc whose object was missing: its current object, read once. */
async function reread(r: SearchReader, doc: ListedDoc): Promise<Body | null> {
  const now = await r.reresolve(doc);
  if (!now || now.blobRef === doc.blobRef) return null;
  return bodyOf(await readVersionContent(r.blobs, now.blobRef), now.currentVersion);
}

async function readOne(r: SearchReader, doc: ListedDoc): Promise<Body | null> {
  const first = bodyOf(await readVersionContent(r.blobs, doc.blobRef), doc.currentVersion);
  return first ?? reread(r, doc);
}

/** `query`: case-insensitive substring over path and content of the first 200 docs by path. */
async function searchContent(
  r: SearchReader,
  sorted: readonly ListedDoc[],
  query: string,
): Promise<Found> {
  const needle = query.toLowerCase();
  const window = sorted.slice(0, SEARCH_DOCS_MAX);
  const files: FileOut[] = [];
  let bytes = 0;
  for (let i = 0; i < window.length; i += SEARCH_READ_CONCURRENCY) {
    const batch = window.slice(i, i + SEARCH_READ_CONCURRENCY);
    const firsts = await Promise.all(
      batch.map(async (d) =>
        bodyOf(await readVersionContent(r.blobs, d.blobRef), d.currentVersion),
      ),
    );
    for (const [k, doc] of batch.entries()) {
      // Re-resolving is rare; done one at a time so a batch never takes more than one connection.
      const body = firsts[k] ?? (await reread(r, doc));
      if (!body || !`${doc.path}\n${body.content}`.toLowerCase().includes(needle)) continue;
      bytes += Buffer.byteLength(body.content, "utf8");
      if (files.length >= MEMORY_RECALL_MAX_FILES || bytes > READ_CONTENT_MAX_BYTES) {
        return { files, truncated: true };
      }
      files.push({
        scope: doc.scope,
        path: doc.path,
        content: body.content,
        version: body.version,
      });
    }
  }
  return { files, truncated: sorted.length > SEARCH_DOCS_MAX };
}

/** Answers a `recall` (`path`, `query` or neither) from the listed docs. Object errors throw. */
export async function searchFiles(
  r: SearchReader,
  input: RecallInput,
  docs: readonly ListedDoc[],
): Promise<Found> {
  const { path, query } = input;
  if (path !== undefined) {
    const doc = docs.find((d) => d.path === path);
    const body = doc ? await readOne(r, doc) : null;
    return doc && body
      ? {
          files: [
            { scope: doc.scope, path: doc.path, content: body.content, version: body.version },
          ],
          truncated: false,
        }
      : { files: [], truncated: false };
  }
  const sorted = [...docs].sort((a, b) =>
    a.path === b.path ? a.scope.localeCompare(b.scope) : a.path.localeCompare(b.path),
  );
  if (query === undefined) {
    return {
      files: sorted
        .slice(0, MEMORY_RECALL_MAX_FILES)
        .map((d) => ({ scope: d.scope, path: d.path, version: d.currentVersion })),
      truncated: sorted.length > MEMORY_RECALL_MAX_FILES,
    };
  }
  return searchContent(r, sorted, query);
}
