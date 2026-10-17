import { and, eq, schedules, sql, type KobeTx } from "@kobe/db";
import { MENTION_MAX_PER_MESSAGE, mentionMarker } from "@kobe/protocol";
import { mentionAllowed } from "../runs/mentions.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";

/**
 * A moved file's `@file` mentions in its owner's schedules follow it (KOBE-304, ac-9): a
 * schedule's `mentions` are paths of the owner's own workspace (KOBE-223), checked when saved and
 * looked up at each run, where a path gone by then stays literal text. After a move in the same
 * transaction, each of the owner's schedules in this team that lists a moved path gets the new
 * path in `mentions` and in its prompt's markers. A new path the mention rules refuse, or a prompt
 * that would outgrow its limit, leaves that schedule as it was (the old marker then stays literal
 * at the next run, as for a deleted file).
 *
 * Not under `withUserScheduleLock` and not audited as a schedule change (review N7): it is a
 * consequence of the member's own move (audited as `workspace.file_moved`). A concurrent PATCH of
 * the same schedule may overwrite it; the mention then degrades to literal text, and the
 * scheduler's stale check covers a fire that races it.
 */

/** `schedules_prompt`: 1–10000 characters. */
const PROMPT_MAX = 10_000;

export interface MovedMentions {
  readonly prompt: string;
  readonly mentions: readonly string[];
}

/** The path `path` has after moving `from` to `to`, or undefined when the move didn't touch it. */
export function movedPath(path: string, from: string, to: string): string | undefined {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : undefined;
}

/** A schedule's prompt and mentions after the move, or undefined when nothing changes. */
export function retargetMentions(
  current: MovedMentions,
  from: string,
  to: string,
): MovedMentions | undefined {
  let prompt = current.prompt;
  let changed = false;
  const mentions = current.mentions.map((path) => {
    const next = movedPath(path, from, to);
    if (next === undefined || !mentionAllowed(next)) return path;
    changed = true;
    prompt = prompt.split(mentionMarker(path)).join(mentionMarker(next));
    return next;
  });
  if (!changed) return undefined;
  const unique = new Set(mentions).size === mentions.length;
  if (!unique || mentions.length > MENTION_MAX_PER_MESSAGE || [...prompt].length > PROMPT_MAX) {
    return undefined;
  }
  return { prompt, mentions };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Rewrites the owner's schedules in this team that mention a moved path; returns how many. */
export async function retargetScheduleMentions(
  tx: KobeTx,
  owner: WorkspaceOwner,
  from: string,
  to: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string; prompt: string; mentions: string[] }>(sql`
    SELECT id, prompt, mentions FROM schedules
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       AND EXISTS (SELECT 1 FROM unnest(mentions) m
                    WHERE m = ${from} OR m LIKE ${`${escapeLike(from)}/%`})
     FOR UPDATE`);
  let updated = 0;
  for (const row of rows.rows) {
    const next = retargetMentions({ prompt: row.prompt, mentions: row.mentions }, from, to);
    if (!next) continue;
    await tx
      .update(schedules)
      .set({ prompt: next.prompt, mentions: [...next.mentions], updatedAt: new Date() })
      .where(and(eq(schedules.teamId, owner.teamId), eq(schedules.id, row.id)));
    updated += 1;
  }
  return updated;
}
