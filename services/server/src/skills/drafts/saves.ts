import { sql, withTeam } from "@kobe/db";
import { findThread } from "../../threads/repository.js";
import { viewerProjectIds } from "../../threads/references.js";
import type { DraftContext } from "./service.js";

/**
 * The `save_skill_draft` saves of one conversation, as the server recorded them (`skill.draft_saved`
 * run events, KOBE-442 review L4): what the Open in Workbench card shows, by tool call. Only for a
 * conversation of this team the caller can read; null otherwise.
 */
export interface RecordedSave {
  readonly toolCallId: string;
  readonly draftId: string;
  readonly name: string;
  readonly created: boolean;
  readonly newBecause?: "shared" | "edited";
}

/** The most saves one answer lists (a conversation rarely has more than a few). */
export const SAVES_MAX = 200;

export async function recordedSaves(
  ctx: DraftContext,
  threadId: string,
): Promise<RecordedSave[] | null> {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const viewer = {
      teamId: ctx.teamId,
      userId: ctx.viewer.userId,
      projectIds: await viewerProjectIds(tx, ctx.teamId, ctx.viewer.userId),
    };
    if (!(await findThread(tx, viewer, threadId))) return null;
    const res = await tx.execute<{ payload: Record<string, unknown> }>(sql`
      SELECT e.payload FROM run_events e
        JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
       WHERE e.team_id = ${ctx.teamId} AND r.thread_id = ${threadId}
         AND e.type = 'skill.draft_saved'
       ORDER BY r.created_at DESC, r.id DESC, e.seq DESC
       LIMIT ${SAVES_MAX}`);
    // The newest SAVES_MAX, oldest first (review LOW-442a: a random run id is no order).
    return res.rows.reverse().map(({ payload: p }) => ({
      toolCallId: String(p.tool_call_id),
      draftId: String(p.draft_id),
      name: String(p.name),
      created: p.created === true,
      ...(p.new_because === "shared" || p.new_because === "edited"
        ? { newBecause: p.new_because }
        : {}),
    }));
  });
}
