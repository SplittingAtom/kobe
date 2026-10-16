import { z } from "zod";
import { workspacePathIssue } from "./sandbox-wire/workspace-sync.js";

/**
 * `@file` mentions (CE22, KOBE-223; notes in docs/ledger/KOBE-223.md). The composer writes a
 * picked file into the message text as a marker, `@file(<path>)`, with the path relative to
 * `/workspace` and percent-encoded where it would break the marker ({@link mentionMarker}), and
 * lists the picked paths in the body's `mentions` ({@link mentionsFieldSchema}). The **server**
 * checks each listed path ({@link mentionPathIssue}), resolves it against the thread owner's own
 * synced workspace, and rewrites exactly the markers `mentionMarker(path)` of listed paths to the
 * file's absolute sandbox path. Any other `@file(...)` text (pasted code, prose) stays literal.
 * No file is uploaded or copied.
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

/**
 * Characters a mentioned file's name may not hold, because they would be written into the user's
 * own prompt: invisible or format characters (`\p{C}`: controls, zero-width and bidi characters,
 * the tag block U+E0000–E007F, private use, unassigned, surrogates), variation selectors and other
 * invisible marks or fillers, line and paragraph separators, spaces other than U+0020, and the
 * shell's `` ` ``, `$` and `;`.
 */
// The class lists single code points on purpose (combining marks among them), never sequences.
/* eslint-disable no-misleading-character-class */
const MENTION_FORBIDDEN =
  /[\p{C}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u034f\u115f\u1160\u180b-\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}`$;]/u;
/* eslint-enable no-misleading-character-class */

/**
 * Why `path` (relative to `/workspace`) cannot be mentioned, or undefined when it can: the
 * workspace path rules (no empty, `.` or `..` segments, backslashes, overlong paths) plus
 * {@link MENTION_FORBIDDEN}. The server refuses such a mention; the picker never offers one.
 */
export function mentionPathIssue(path: string): string | undefined {
  if (MENTION_FORBIDDEN.test(path)) return "invisible, format or shell character";
  return workspacePathIssue(path);
}

/**
 * `mentions` of a message, steer, queued edit or schedule: the workspace paths the member picked,
 * unique, at most {@link MENTION_MAX_PER_MESSAGE}. Shape only; the server applies
 * {@link mentionPathIssue} and the manifest lookup (refusals are `invalid_mention`).
 */
export const mentionsFieldSchema = z
  .array(z.string().min(1).max(MENTION_ENCODED_MAX))
  .max(MENTION_MAX_PER_MESSAGE)
  .refine((paths) => new Set(paths).size === paths.length, "duplicate mentions");
