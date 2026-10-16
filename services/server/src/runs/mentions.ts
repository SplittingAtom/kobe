import type { KobeTx } from "@kobe/db";
import {
  decodeMentionPath,
  findMentionMarkers,
  MENTION_MAX_PER_MESSAGE,
  mentionMarker,
  mentionPathIssue,
  sandboxPathOf,
} from "@kobe/protocol";
import { isInternalPath } from "../workspace-files/paths.js";
import { liveFilePaths } from "../workspace-files/search.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import { RunError } from "./errors.js";

/**
 * Server-side rewrite of `@file` mentions (CE22, KOBE-223; protocol `mentions.ts`). Mentions are
 * structured: the body lists the picked workspace paths (`mentions`), and only the markers
 * `mentionMarker(path)` of listed paths are rewritten; every other `@file(...)` in the text (pasted
 * code, prose, a stored path that looks like one) stays literal. Each listed path is checked
 * against the mention rules (no invisible, format or shell characters, no traversal) and resolved
 * against the thread owner's own synced manifest (`workspace_files`, inside the caller's
 * `withTeam()`); nothing is guessed or normalised into another file.
 */

/** The longest prompt a rewrite may produce (`submitMessageBodySchema.content`). */
export const MENTION_CONTENT_MAX = 200_000;
/** A path written into the prompt as it is; anything else goes in a Markdown code span. */
const PLAIN = /^[\p{L}\p{M}\p{N}_./+@,=-]+$/u;
const MESSAGE_PATH_MAX = 200;

const refuse = (message: string): never => {
  throw new RunError("invalid_mention", message);
};

const shown = (path: string) =>
  path.length > MESSAGE_PATH_MAX ? `${path.slice(0, MESSAGE_PATH_MAX)}…` : path;

/** Whether a listed path may be mentioned at all (rules only, no lookup). */
export function mentionAllowed(path: string): boolean {
  return mentionPathIssue(path) === undefined && !isInternalPath(path);
}

/**
 * Refuses (422 `invalid_mention`) a mention list that breaks the rules: more than
 * {@link MENTION_MAX_PER_MESSAGE} paths, or a path with invisible, format or shell characters,
 * outside `/workspace` or agent-internal. Pure, so it runs before any upload is staged.
 */
export function checkMentionPaths(paths: readonly string[]): void {
  if (paths.length > MENTION_MAX_PER_MESSAGE) {
    refuse(`Mention at most ${MENTION_MAX_PER_MESSAGE} files in one message.`);
  }
  if (!paths.every(mentionAllowed)) {
    refuse(
      "A mentioned file has a name that can't be mentioned (it is outside /workspace or holds " +
        "invisible, control or shell characters). Rename it first.",
    );
  }
}

/** How an absolute path is written into the prompt: plain, or as a Markdown code span. */
export function promptPath(path: string): string {
  const absolute = sandboxPathOf(path);
  if (PLAIN.test(absolute)) return absolute;
  // Backticks are refused in mention paths; the fence still outgrows any run, to be safe.
  const longest = Math.max(0, ...(absolute.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = absolute.startsWith("`") || absolute.endsWith("`") ? " " : "";
  return `${fence}${pad}${absolute}${pad}${fence}`;
}

/** `content` with the markers of `paths` replaced by their absolute sandbox paths. */
function replaceMarkers(content: string, paths: ReadonlySet<string>): string {
  let out = "";
  let at = 0;
  for (const marker of findMentionMarkers(content)) {
    const path = decodeMentionPath(marker.encoded);
    // Only the exact marker the composer writes for a listed path; anything else is literal text.
    if (path === undefined || !paths.has(path) || marker.raw !== mentionMarker(path)) continue;
    out += content.slice(at, marker.index) + promptPath(path);
    at = marker.index + marker.raw.length;
  }
  return out + content.slice(at);
}

export interface MentionRewrite {
  readonly text: string;
  /** Listed paths that were not rewritten (only with `missing: "keep"`). */
  readonly skipped: number;
}

/**
 * `content` with the markers of the listed `paths` rewritten to absolute sandbox paths, after
 * checking each path and that it is a live file of `owner`'s synced workspace. `missing:
 * "refuse"` (a member's message) throws `RunError("invalid_mention")` for any bad or unknown
 * path; `"keep"` (a scheduled run, checked when the schedule was saved) leaves the markers of
 * such paths as literal text and counts them in `skipped`.
 */
export async function rewriteMentions(
  tx: KobeTx,
  owner: WorkspaceOwner,
  content: string,
  paths: readonly string[],
  missing: "refuse" | "keep" = "refuse",
): Promise<MentionRewrite> {
  if (paths.length === 0) return { text: content, skipped: 0 };
  if (missing === "refuse") checkMentionPaths(paths);
  const allowed = [...new Set(paths)].filter(mentionAllowed).slice(0, MENTION_MAX_PER_MESSAGE);
  const live = await liveFilePaths(tx, owner, allowed);
  const gone = paths.find((p) => !live.has(p));
  if (missing === "refuse" && gone !== undefined) {
    refuse(`There is no file ${shown(gone)} in your workspace. Pick it from the list again.`);
  }
  const text = replaceMarkers(content, live);
  if (text.length > MENTION_CONTENT_MAX) refuse("The message is too long with the file paths.");
  return { text, skipped: new Set(paths).size - live.size };
}

/**
 * Refuses (422 `invalid_mention`) a schedule's mention list unless every path follows the rules
 * and is a live file of the owner's workspace now (KOBE-223 S3).
 */
export async function checkMentionsExist(
  tx: KobeTx,
  owner: WorkspaceOwner,
  paths: readonly string[],
): Promise<void> {
  await rewriteMentions(tx, owner, "", paths, "refuse");
}
