import { z } from "zod";

/** Limits of `searchThreads` (KOBE-33). */
export const THREAD_SEARCH_DEFAULT_LIMIT = 20;
export const THREAD_SEARCH_MAX_LIMIT = 50;
export const THREAD_SEARCH_MAX_QUERY_LENGTH = 256;
/** Upper bound on the viewer's project ids passed in one search. */
export const THREAD_SEARCH_MAX_PROJECT_IDS = 1000;

/**
 * Highlight delimiters handed to ts_headline: Unicode private-use characters, stripped from the
 * source text first, so a snippet is split into plain-text segments and never carries markup.
 */
export const HIGHLIGHT_START = "\uE000";
export const HIGHLIGHT_STOP = "\uE001";

const uuid = z.uuid();

export const searchThreadsInputSchema = z.strictObject({
  /** The signed-in user; only their own threads and threads shared to `projectIds` are searched. */
  viewerUserId: uuid,
  /** Web-search syntax (`"phrase"`, `-exclude`, `or`); also trigram-matched against titles. */
  query: z.string().trim().min(1).max(THREAD_SEARCH_MAX_QUERY_LENGTH),
  /**
   * Projects of the active team the viewer is a member of (resolved by the caller until projects
   * exist, KOBE-57). Threads shared to these projects are searchable too. Default: none.
   */
  projectIds: z.array(uuid).max(THREAD_SEARCH_MAX_PROJECT_IDS).default([]),
  /** Only threads in this project (§6.1 `project_id`). */
  projectId: uuid.optional(),
  /**
   * Only threads with activity at or after this instant. Pass now minus the team retention period
   * (D18) so threads due for purge are never surfaced; omit while a legal hold applies or retention
   * is "forever".
   */
  activeSince: z.date().optional(),
  limit: z.number().int().min(1).max(THREAD_SEARCH_MAX_LIMIT).default(THREAD_SEARCH_DEFAULT_LIMIT),
  /** `nextCursor` of the previous page. */
  cursor: z.string().max(512).optional(),
});

export type SearchThreadsInput = z.input<typeof searchThreadsInputSchema>;
export type ParsedSearchThreadsInput = z.output<typeof searchThreadsInputSchema>;

/**
 * Keyset position after the last hit of a page: (score, last activity in epoch microseconds, id),
 * all compared descending. Microseconds as a decimal string because timestamptz has µs precision
 * and a JS Date only ms; the score is a float8 that round-trips exactly through JSON.
 */
export interface SearchCursor {
  readonly score: number;
  readonly activityMicros: string;
  readonly id: string;
}

const cursorSchema = z.strictObject({
  s: z.number().finite().nonnegative(),
  a: z.string().regex(/^-?\d{1,20}$/),
  i: uuid,
});

export function encodeCursor(cursor: SearchCursor): string {
  const json = JSON.stringify({ s: cursor.score, a: cursor.activityMicros, i: cursor.id });
  return Buffer.from(json, "utf8").toString("base64url");
}

/** Decodes a cursor from `encodeCursor`; null when it is malformed or tampered with. */
export function decodeCursor(encoded: string): SearchCursor | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success) return null;
  return { score: parsed.data.s, activityMicros: parsed.data.a, id: parsed.data.i };
}

/** A piece of a snippet; `highlight` marks a query match. Plain text: render it escaped. */
export interface SnippetSegment {
  readonly text: string;
  readonly highlight: boolean;
}

/** Splits ts_headline output (delimited by HIGHLIGHT_START/STOP) into plain-text segments. */
export function parseSnippet(headline: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let highlight = false;
  let current = "";
  const flush = (): void => {
    if (current !== "") segments.push({ text: current, highlight });
    current = "";
  };
  for (const ch of headline) {
    if (ch === HIGHLIGHT_START || ch === HIGHLIGHT_STOP) {
      flush();
      highlight = ch === HIGHLIGHT_START;
    } else {
      current += ch;
    }
  }
  flush();
  return segments;
}
