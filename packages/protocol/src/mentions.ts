/**
 * `@file` mentions (CE22, KOBE-223; notes in docs/ledger/KOBE-223.md). The composer writes a
 * mention into the message text as a marker, `@file(<path>)`, with the path relative to
 * `/workspace` and percent-encoded where it would break the marker ({@link encodeMentionPath}).
 * On submit the **server** resolves each marker against the thread owner's own synced workspace
 * and rewrites it to the file's absolute sandbox path; the marker itself never reaches Pi or the
 * stored prompt. No file is uploaded or copied. Additive: nothing else in the contract changes.
 */

/** Where the workspace is mounted in every sandbox. */
export const SANDBOX_WORKSPACE_ROOT = "/workspace";

/** Most distinct files one message may mention. */
export const MENTION_MAX_PER_MESSAGE = 20;
/** Longest encoded path inside one marker (a workspace path is at most 1024 UTF-8 bytes). */
export const MENTION_ENCODED_MAX = 4096;

const MARKER = new RegExp(`@file\\(([^()\\s]{1,${MENTION_ENCODED_MAX}})\\)`, "gu");
// Characters a marker cannot hold as they are: its own delimiters, `%`, whitespace, and control,
// format, private-use and unassigned code points (invisible or display-breaking in the text).
const ENCODE = /[%()\s\p{C}]/gu;

const encodeChar = (c: string): string =>
  [...new TextEncoder().encode(c)]
    .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");

/** The marker form of a workspace path: `%`, `(`, `)`, whitespace and invisibles percent-encoded. */
export function encodeMentionPath(path: string): string {
  return path.replace(ENCODE, encodeChar);
}

/** The marker the composer inserts for a workspace path (relative to `/workspace`). */
export function mentionMarker(path: string): string {
  return `@file(${encodeMentionPath(path)})`;
}

/**
 * The path a marker carries, percent-decoded once, or undefined when its encoding is malformed.
 * The result is untrusted: the server validates and resolves it (never the client).
 */
export function decodeMentionPath(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export interface MentionMarkerMatch {
  /** The marker as written, `@file(...)`. */
  readonly raw: string;
  /** The encoded path between the parentheses. */
  readonly encoded: string;
  readonly index: number;
}

/** Every `@file(...)` marker in `text`, in order. */
export function findMentionMarkers(text: string): MentionMarkerMatch[] {
  return [...text.matchAll(MARKER)].map((m) => ({
    raw: m[0],
    encoded: m[1] ?? "",
    index: m.index,
  }));
}

/** The absolute sandbox path of a workspace path: `a/b.csv` -> `/workspace/a/b.csv`. */
export function sandboxPathOf(path: string): string {
  return `${SANDBOX_WORKSPACE_ROOT}/${path}`;
}
