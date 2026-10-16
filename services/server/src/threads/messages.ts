import { sql, type KobeTx } from "@kobe/db";

export { cutText } from "./entry-output.js";

/**
 * Plain-text reads of a thread's conversation for the server's own uses (KOBE-219): the title
 * call's prompt and the rail's hover card. Every query states `team_id` (break-glass rule) and
 * reads Postgres only (never a sandbox, D14). An offloaded body (D15) has no inline text and
 * counts as empty.
 */

type MessageRow = {
  readonly seq: number;
  readonly content: unknown;
};

/** The text parts of a Pi message's content, joined. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: unknown; text?: unknown } | null) =>
      part?.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

export interface FirstMessage {
  readonly seq: number;
  readonly text: string;
}

/** The thread's first user message (by append order), or undefined before there is one. */
export async function firstUserMessage(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<FirstMessage | undefined> {
  const res = await tx.execute<MessageRow>(sql`
    SELECT seq, payload -> 'message' -> 'content' AS content
      FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND type = 'message'
       AND payload -> 'message' ->> 'role' = 'user'
     ORDER BY seq LIMIT 1`);
  const row = res.rows[0];
  return row ? { seq: Number(row.seq), text: messageText(row.content).trim() } : undefined;
}

/** The text of the first assistant message after `seq` that has any (the answer's start). */
export async function firstAnswerAfter(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  seq: number,
): Promise<string | undefined> {
  const res = await tx.execute<MessageRow>(sql`
    SELECT seq, payload -> 'message' -> 'content' AS content
      FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND type = 'message'
       AND seq > ${seq} AND payload -> 'message' ->> 'role' = 'assistant'
     ORDER BY seq LIMIT 8`);
  for (const row of res.rows) {
    const text = messageText(row.content).trim();
    if (text !== "") return text;
  }
  return undefined;
}

/** Most message entries the card's count reads (each read opens the entry's payload). */
export const MESSAGE_COUNT_SCAN = 1_000;

/**
 * Messages as the member sees them: their prompts and the agent's answers (an assistant turn
 * that only called tools is not one), on every branch. Reads at most {@link MESSAGE_COUNT_SCAN}
 * message entries (review L4): `capped` says the thread has more.
 */
export async function messageCount(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<{ readonly count: number; readonly capped: boolean }> {
  const res = await tx.execute<{ n: number | string; scanned: number | string }>(sql`
    SELECT count(*) FILTER (WHERE e.role = 'user'
                              OR (e.role = 'assistant' AND e.stop IS DISTINCT FROM 'toolUse')) AS n,
           count(*) AS scanned
      FROM (SELECT payload -> 'message' ->> 'role' AS role,
                   payload -> 'message' ->> 'stopReason' AS stop
              FROM thread_entries
             WHERE team_id = ${teamId} AND thread_id = ${threadId} AND type = 'message'
             ORDER BY seq LIMIT ${MESSAGE_COUNT_SCAN}) e`);
  const row = res.rows[0];
  return {
    count: Number(row?.n ?? 0),
    capped: Number(row?.scanned ?? 0) >= MESSAGE_COUNT_SCAN,
  };
}

/** The latest exchange: the thread's last user message and the last answer text after it. */
export interface LastExchange {
  readonly prompt: string;
  readonly answer: string | undefined;
}

/**
 * The thread's latest user message (by append order) and the last assistant text after it: what
 * the follow-up call (KOBE-222) quotes. Undefined when there is no user message with text.
 */
export async function lastExchange(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<LastExchange | undefined> {
  const res = await tx.execute<MessageRow>(sql`
    SELECT seq, payload -> 'message' -> 'content' AS content
      FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND type = 'message'
       AND payload -> 'message' ->> 'role' = 'user'
     ORDER BY seq DESC LIMIT 1`);
  const row = res.rows[0];
  const prompt = row ? messageText(row.content).trim() : "";
  if (!row || prompt === "") return undefined;
  const answers = await tx.execute<MessageRow>(sql`
    SELECT seq, payload -> 'message' -> 'content' AS content
      FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND type = 'message'
       AND seq > ${Number(row.seq)} AND payload -> 'message' ->> 'role' = 'assistant'
     ORDER BY seq DESC LIMIT 8`);
  const answer = answers.rows.map((r) => messageText(r.content).trim()).find((t) => t !== "");
  return { prompt, answer };
}
