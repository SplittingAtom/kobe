import type { KobeTx } from "@kobe/db";
import { findPinnableAgent } from "../agents/versions.js";
import { cutText, firstUserMessage, messageCount } from "./messages.js";
import { findThread, type Viewer } from "./repository.js";
import { THREAD_CARD_MESSAGE_CHARS, type ThreadCard } from "./schemas.js";

/**
 * The rail's hover card (CE18, KOBE-219): instead of a model-written summary, the thread's first
 * user message (cut short), its agent, its last activity and how many messages it holds. Read
 * when the card opens, for whoever may read the thread; Postgres only (never a sandbox).
 */
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
    message_count: await messageCount(tx, viewer.teamId, threadId),
  };
}
