import type { KobeTx } from "@kobe/db";
import {
  decodeMentionPath,
  findMentionMarkers,
  MENTION_MAX_PER_MESSAGE,
  sandboxPathOf,
  SANDBOX_WORKSPACE_ROOT,
  workspacePathIssue,
  type MentionMarkerMatch,
} from "@kobe/protocol";
import { isInternalPath } from "../workspace-files/paths.js";
import { liveFilePaths } from "../workspace-files/search.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import { RunError } from "./errors.js";

/**
 * Server-side rewrite of `@file(...)` mentions (CE22, KOBE-223; protocol `mentions.ts`). The
 * client's marker only names a path; the server decides. Each marker is decoded once, checked
 * against the workspace path rules, and resolved against the thread owner's own synced manifest
 * (`workspace_files`, inside the caller's `withTeam()`), then replaced by the file's absolute
 * sandbox path. Anything else refuses the whole message (`invalid_mention`): nothing is guessed,
 * normalised into another file, or passed through.
 */

/** Line breaks and other separators a name could smuggle into the prompt (beyond C0 controls). */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/** A path written into the prompt as it is; anything else goes in a Markdown code span. */
const PLAIN = /^[\p{L}\p{M}\p{N}_./+@,=-]+$/u;
const MESSAGE_PATH_MAX = 200;

const refuse = (message: string): never => {
  throw new RunError("invalid_mention", message);
};

/** The workspace path (relative to `/workspace`) a marker names, or a refusal. */
export function mentionedPath(marker: MentionMarkerMatch): string {
  const decoded = decodeMentionPath(marker.encoded);
  if (decoded === undefined) return refuse("A file mention is not encoded correctly.");
  if (UNSAFE.test(decoded)) return refuse("A file mention holds a control character.");
  let path = decoded;
  if (path.startsWith("/")) {
    // Absolute paths are accepted only inside the workspace mount, and only as files in it.
    if (!path.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)) {
      return refuse(`Only files in ${SANDBOX_WORKSPACE_ROOT} can be mentioned.`);
    }
    path = path.slice(SANDBOX_WORKSPACE_ROOT.length + 1);
  }
  // No `..`, `.` or empty segments, no backslashes, bidi controls, or overlong paths.
  if (workspacePathIssue(path) !== undefined) {
    return refuse(`Only files in ${SANDBOX_WORKSPACE_ROOT} can be mentioned.`);
  }
  return path;
}

/** How an absolute path is written into the prompt: plain, or as a Markdown code span. */
export function promptPath(path: string): string {
  const absolute = sandboxPathOf(path);
  if (PLAIN.test(absolute)) return absolute;
  const longest = Math.max(0, ...(absolute.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = absolute.startsWith("`") || absolute.endsWith("`") ? " " : "";
  return `${fence}${pad}${absolute}${pad}${fence}`;
}

const shown = (path: string) =>
  path.length > MESSAGE_PATH_MAX ? `${path.slice(0, MESSAGE_PATH_MAX)}…` : path;

/**
 * `content` with every `@file(...)` marker replaced by the mentioned file's absolute sandbox path,
 * after checking each one names a live file in `owner`'s synced workspace. Content without
 * markers comes back unchanged (no query). Throws `RunError("invalid_mention")`.
 */
export async function rewriteMentions(
  tx: KobeTx,
  owner: WorkspaceOwner,
  content: string,
): Promise<string> {
  const markers = findMentionMarkers(content);
  if (markers.length === 0) return content;
  const paths = markers.map(mentionedPath);
  const distinct = [...new Set(paths)];
  if (distinct.length > MENTION_MAX_PER_MESSAGE) {
    refuse(`Mention at most ${MENTION_MAX_PER_MESSAGE} files in one message.`);
  }
  const internal = distinct.find(isInternalPath);
  const live = await liveFilePaths(
    tx,
    owner,
    distinct.filter((p) => !isInternalPath(p)),
  );
  const missing = internal ?? distinct.find((p) => !live.has(p));
  if (missing !== undefined) {
    refuse(`There is no file ${shown(missing)} in your workspace. Pick it from the list again.`);
  }
  let out = "";
  let at = 0;
  markers.forEach((marker, i) => {
    out += content.slice(at, marker.index) + promptPath(paths[i] as string);
    at = marker.index + marker.raw.length;
  });
  return out + content.slice(at);
}
