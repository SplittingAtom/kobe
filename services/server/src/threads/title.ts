import {
  GENERATED_TITLE_MAX_CHARS,
  generatedTitleSchema,
  type ServerCallRequest,
} from "@kobe/protocol";
import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { cutText, firstUserMessage } from "./messages.js";

/**
 * Auto-titles (CE18, KOBE-219) on the KOBE-234 contract (docs/design/server-model-calls.md): after
 * one of a thread's first completed message runs, the server asks the thread's own model for a
 * short title, once. A rename (`title_locked`, KOBE-215/292) always wins and is never overwritten;
 * a title already set (by the member, a fork or a schedule) is never replaced. When no title can
 * be made (titles not configured, no model, the last attempt failed), the first line of the first
 * prompt becomes the title instead (review M3), under the same guard.
 */

/** A model that keeps failing costs at most this many title calls (design doc, Flow 1). */
export const TITLE_ATTEMPT_RUNS = 3;
/** What the prompt quotes of the first message and of the answer (a title needs little). */
export const TITLE_QUOTE_CHARS = 2_000;
/** How long the title write waits for the thread row (a run starting holds it briefly). */
const TITLE_LOCK_TIMEOUT = "5s";

const SYSTEM_PROMPT =
  "You name conversations. Reply with only a short title of 3 to 7 words for the conversation " +
  "below: plain text on one line, no quotes, no trailing punctuation, in the language of the " +
  "user's message.";

/** The title request's messages: the first user message and the start of the answer, quoted. */
export function titleMessages(
  first: string,
  answer: string | undefined,
): ServerCallRequest["messages"] {
  const quoted = [
    `First message:\n${cutText(first, TITLE_QUOTE_CHARS)}`,
    ...(answer ? [`Start of the answer:\n${cutText(answer, TITLE_QUOTE_CHARS)}`] : []),
  ].join("\n\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: quoted },
  ];
}

export const QUOTES = /^["'“”‘’«»`]+|["'“”‘’«»`]+$/gu;
const MARKUP = /^[#>*_\s-]+|[*_\s]+$/gu;
const LABEL = /^title\s*:\s*/iu;
const TRAILING = /[.!?:;,…\s]+$/u;
/** Line breaks, including the Unicode separators and NEL that `\n` splitting misses. */
export const LINES = /\r\n|[\n\r\u0085\u2028\u2029]/u;
/** Controls, format characters (bidi, zero-width) and separators (review L1). */
export const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** A link or address in a title is model output steering the reader (review L2): refused. */
export const LINKISH = /:\/\/|\bwww\.|\[[^\]]*\]\(/iu;

/** Cuts at the last word boundary within the limit (or hard, for one long word). */
function fit(title: string, max: number): string {
  if (title.length <= max) return title;
  const cut = cutText(title, max);
  const space = cut.lastIndexOf(" ");
  return (space >= max / 2 ? cut.slice(0, space) : cut).replace(TRAILING, "");
}

/** The first non-empty line, tabs as spaces, every unsafe character removed. */
function firstLine(text: string): string | undefined {
  return text
    .split(LINES)
    .map((l) => l.replace(/\t/gu, " ").replace(UNSAFE, "").trim())
    .find((l) => l !== "");
}

/**
 * The model's reply as a title (`generatedTitleSchema`): its first non-empty line without
 * quotes, Markdown marks, a "Title:" label, trailing punctuation, controls, format characters or
 * separators, whitespace collapsed, at most {@link GENERATED_TITLE_MAX_CHARS}. Undefined when
 * nothing usable is left, or when it holds a link.
 */
export function normaliseTitle(reply: string): string | undefined {
  const line = firstLine(reply);
  if (line === undefined || LINKISH.test(line)) return undefined;
  let title = line;
  for (let i = 0; i < 3; i += 1) {
    title = title
      .replace(MARKUP, "")
      .replace(LABEL, "")
      .replace(QUOTES, "")
      .replace(TRAILING, "")
      .replace(/\s+/gu, " ")
      .trim();
  }
  const parsed = generatedTitleSchema.safeParse(fit(title, GENERATED_TITLE_MAX_CHARS));
  return parsed.success ? parsed.data : undefined;
}

/**
 * The fallback title (review M3): the first line of the member's first prompt, unsafe characters
 * removed, whitespace collapsed, cut at a word boundary with "…" to at most
 * {@link GENERATED_TITLE_MAX_CHARS}, as the web showed it meanwhile. Undefined for an empty one.
 */
export function fallbackTitle(prompt: string): string | undefined {
  const line = firstLine(prompt)?.replace(/\s+/gu, " ");
  if (!line) return undefined;
  const max = GENERATED_TITLE_MAX_CHARS;
  const title = line.length <= max ? line : `${fit(line, max - 1).trimEnd()}…`;
  const parsed = generatedTitleSchema.safeParse(title);
  return parsed.success ? parsed.data : undefined;
}

/** What the run-end transaction does about the thread's title (KOBE-234 ac-a, review M3). */
export type TitleDecision = "announce" | "fallback" | "none";

/**
 * In the transaction that completes the run: whether `run.completed` announces a title. The
 * thread has no title, is not locked by a rename, is no builder test thread and not in Trash, and
 * the run is a completed message run. Then: `announce` when this server can call a model and the
 * run is among the thread's first {@link TITLE_ATTEMPT_RUNS} completed ones (this run's own status
 * is already written); otherwise `fallback` (no title call will ever come).
 */
export async function titleDecisionInTx(
  tx: KobeTx,
  ids: { readonly teamId: string; readonly runId: string; readonly threadId: string },
  canCall: boolean,
): Promise<TitleDecision> {
  const { teamId, runId, threadId } = ids;
  const res = await tx.execute<{ eligible: boolean; attempts: number | string }>(sql`
    SELECT (t.title IS NULL AND NOT t.title_locked AND NOT t.is_test AND NOT t.skill_eval AND t.deleted_at IS NULL
            AND r.kind = 'message' AND r.status = 'completed') AS eligible,
           (SELECT count(*) FROM runs c
             WHERE c.team_id = ${teamId} AND c.thread_id = ${threadId}
               AND c.kind = 'message' AND c.status = 'completed') AS attempts
      FROM threads t
      JOIN runs r ON r.team_id = t.team_id AND r.thread_id = t.id
     WHERE t.team_id = ${teamId} AND t.id = ${threadId} AND r.id = ${runId}`);
  const row = res.rows[0];
  if (row?.eligible !== true) return "none";
  return canCall && Number(row.attempts) <= TITLE_ATTEMPT_RUNS ? "announce" : "fallback";
}

/** Whether this run was the thread's last title attempt (its call failed: time for the fallback). */
export async function lastTitleAttempt(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<boolean> {
  const res = await tx.execute<{ n: number | string }>(sql`
    SELECT count(*) AS n FROM runs
     WHERE team_id = ${teamId} AND thread_id = ${threadId}
       AND kind = 'message' AND status = 'completed'`);
  return Number(res.rows[0]?.n ?? 0) >= TITLE_ATTEMPT_RUNS;
}

/**
 * Saves a generated title unless the thread has one or a rename locked it meanwhile (KOBE-234
 * ac-b); true when a row changed. `team_id` is explicit (break-glass rule).
 */
export async function saveGeneratedTitle(
  db: KobeDb,
  teamId: string,
  threadId: string,
  title: string,
): Promise<boolean> {
  const value = generatedTitleSchema.parse(title);
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${TITLE_LOCK_TIMEOUT}'`));
    const res = await tx.execute(sql`
      UPDATE threads SET title = ${value}
       WHERE team_id = ${teamId} AND id = ${threadId} AND title IS NULL AND NOT title_locked
      RETURNING id`);
    return (res.rowCount ?? 0) > 0;
  });
}

/**
 * Writes the fallback title (review M3) with the same guard as a generated one: the first line of
 * the thread's first user message, else this run's prompt. Returns it when a row changed.
 */
export async function saveFallbackTitleInTx(
  tx: KobeTx,
  ids: { readonly teamId: string; readonly runId: string; readonly threadId: string },
): Promise<string | undefined> {
  const { teamId, runId, threadId } = ids;
  const first = await firstUserMessage(tx, teamId, threadId);
  let prompt = first?.text ?? "";
  if (prompt === "") {
    const run = await tx.execute<{ input: string }>(sql`
      SELECT input FROM runs WHERE team_id = ${teamId} AND id = ${runId}`);
    prompt = run.rows[0]?.input ?? "";
  }
  const title = fallbackTitle(prompt);
  if (title === undefined) return undefined;
  const res = await tx.execute(sql`
    UPDATE threads SET title = ${title}
     WHERE team_id = ${teamId} AND id = ${threadId} AND title IS NULL AND NOT title_locked
    RETURNING id`);
  return (res.rowCount ?? 0) > 0 ? title : undefined;
}

/** {@link saveFallbackTitleInTx} in its own transaction (after a run, off its path). */
export function saveFallbackTitle(
  db: KobeDb,
  ids: { readonly teamId: string; readonly runId: string; readonly threadId: string },
): Promise<string | undefined> {
  return withTeam(db, ids.teamId, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${TITLE_LOCK_TIMEOUT}'`));
    return saveFallbackTitleInTx(tx, ids);
  });
}
