import { sql, type KobeTx } from "@kobe/db";
import { THREAD_CARD_BRANCHES_MAX } from "@kobe/protocol";
import { findPinnableAgent } from "../agents/versions.js";
import { cutText, firstUserMessage, messageCount } from "./messages.js";
import { findThread, type Viewer } from "./repository.js";
import { THREAD_CARD_MESSAGE_CHARS, type ThreadCard } from "./schemas.js";

/**
 * The rail's hover card (CE18, KOBE-219): instead of a model-written summary, the thread's first
 * user message (cut short), its agent, its last activity and how many messages it holds. Read
 * when the card opens, for whoever may read the thread; Postgres only (never a sandbox).
 */
async function counted(tx: KobeTx, teamId: string, threadId: string) {
  const { count, capped } = await messageCount(tx, teamId, threadId);
  return { message_count: count, message_count_capped: capped };
}

/**
 * Junctions (CT12): entries with more than one child, over `thread_entries_parent_idx`. The root's
 * hidden settings entry is an entry like any other, so two first messages are one junction; a
 * straight thread has none. Stops after {@link THREAD_CARD_BRANCHES_MAX}.
 */
export async function junctionCount(tx: KobeTx, teamId: string, threadId: string) {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT e.parent_id FROM thread_entries e
       WHERE e.team_id = ${teamId} AND e.thread_id = ${threadId} AND e.parent_id IS NOT NULL
       GROUP BY e.parent_id
      HAVING count(*) > 1
       LIMIT ${THREAD_CARD_BRANCHES_MAX + 1}
    ) j`);
  const n = rows[0]?.n ?? 0;
  return {
    branches: Math.min(n, THREAD_CARD_BRANCHES_MAX),
    branches_capped: n > THREAD_CARD_BRANCHES_MAX,
  };
}

export async function threadCard(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
): Promise<ThreadCard | null> {
  const found = await findThread(tx, viewer, threadId);
  if (!found) return null;
  const { thread } = found;
  const first = await firstUserMessage(tx, viewer.teamId, threadId);
  const text = first?.text.replace(/\s+/gu, " ").trim() ?? "";
  const agent = thread.agentId
    ? await findPinnableAgent(
        tx,
        { teamId: viewer.teamId, userId: thread.ownerUserId },
        thread.agentId,
      )
    : null;
  return {
    thread_id: threadId,
    first_message: text === "" ? null : cutText(text, THREAD_CARD_MESSAGE_CHARS),
    first_message_truncated: text.length > THREAD_CARD_MESSAGE_CHARS,
    agent_id: thread.agentId,
    agent_name: agent?.frontmatter.name ?? null,
    last_activity_at: thread.lastActivityAt.toISOString(),
    ...(await counted(tx, viewer.teamId, threadId)),
    ...(await junctionCount(tx, viewer.teamId, threadId)),
  };
}
