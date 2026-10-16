import {
  GENERATED_TITLE_MAX_CHARS,
  generatedTitleSchema,
  type ServerCallRequest,
} from "@kobe/protocol";
import { sql, withTeam, type AgentScope, type KobeDb, type KobeTx } from "@kobe/db";
import { resolveRunModel } from "../runs/models.js";
import type { RunAgentResolver } from "../runs/seams.js";
import { cutText, firstAnswerAfter, firstUserMessage } from "./messages.js";

/**
 * Auto-titles (CE18, KOBE-219) on the KOBE-234 contract (docs/design/server-model-calls.md): after
 * one of a thread's first completed message runs, the server asks the thread's own model for a
 * short title, once. A rename (`title_locked`, KOBE-215/292) always wins and is never overwritten;
 * a title already set (by the member, a fork or a schedule) is never replaced.
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

const QUOTES = /^["'“”‘’«»`]+|["'“”‘’«»`]+$/gu;
const MARKUP = /^[#>*_\s-]+|[*_\s]+$/gu;
const LABEL = /^title\s*:\s*/iu;
const TRAILING = /[.!?:;,…\s]+$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/gu;

/** Cuts at the last word boundary within the limit (or hard, for one long word). */
function fit(title: string, max: number): string {
  if (title.length <= max) return title;
  const cut = cutText(title, max);
  const space = cut.lastIndexOf(" ");
  return (space >= max / 2 ? cut.slice(0, space) : cut).replace(TRAILING, "");
}

/**
 * The model's reply as a title (`generatedTitleSchema`): its first non-empty line without
 * quotes, Markdown marks, a "Title:" label or trailing punctuation, whitespace collapsed, at most
 * {@link GENERATED_TITLE_MAX_CHARS}. Undefined when nothing usable is left.
 */
export function normaliseTitle(reply: string): string | undefined {
  const line = reply
    .split(/\r?\n/u)
    .map((l) => l.replace(/\t/gu, " ").replace(CONTROL, "").trim())
    .find((l) => l !== "");
  if (line === undefined) return undefined;
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
 * In the transaction that completes the run (KOBE-234 ac-a): whether `run.completed` announces a
 * title. The thread has no title, is not locked by a rename, is no builder test thread and not in
 * Trash, and the run is a message run among the thread's first {@link TITLE_ATTEMPT_RUNS}
 * completed ones (this run's own status is already written).
 */
export async function wantsTitleInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  threadId: string,
): Promise<boolean> {
  const res = await tx.execute<{ wanted: boolean }>(sql`
    SELECT (t.title IS NULL AND NOT t.title_locked AND NOT t.is_test AND t.deleted_at IS NULL
            AND r.kind = 'message' AND r.status = 'completed'
            AND (SELECT count(*) FROM runs c
                  WHERE c.team_id = ${teamId} AND c.thread_id = ${threadId}
                    AND c.kind = 'message' AND c.status = 'completed') <= ${TITLE_ATTEMPT_RUNS}
           ) AS wanted
      FROM threads t
      JOIN runs r ON r.team_id = t.team_id AND r.thread_id = t.id
     WHERE t.team_id = ${teamId} AND t.id = ${threadId} AND r.id = ${runId}`);
  return res.rows[0]?.wanted === true;
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

/** What a title call needs, read at call time (KOBE-234: the model is resolved then). */
export interface TitleSource {
  /** The member the run was leased to: the call's budget line and virtual key. */
  readonly userId: string;
  /** `<gateway provider>/<model>`. */
  readonly model: string;
  readonly messages: ServerCallRequest["messages"];
}

type ThreadPin = {
  readonly owner_user_id: string;
  readonly agent_scope: AgentScope | null;
  readonly agent_id: string | null;
  readonly agent_version: number | null;
  readonly model_alias: string | null;
  readonly untitled: boolean;
  readonly user_id: string | null;
};

/**
 * The title call's member, model and prompt; undefined when there is nothing to call (titled or
 * locked meanwhile, no lease, no enabled model, no first message). The model is the thread's
 * resolved one: an agent's pin wins, then the thread's choice, else the team default
 * (`resolveRunModel`, as `run.start`); a model no longer enabled is a skip.
 */
export async function loadTitleSource(
  tx: KobeTx,
  agents: RunAgentResolver,
  ids: { readonly teamId: string; readonly runId: string; readonly threadId: string },
): Promise<TitleSource | undefined> {
  const { teamId, runId, threadId } = ids;
  const res = await tx.execute<ThreadPin>(sql`
    SELECT t.owner_user_id, t.agent_scope, t.agent_id, t.agent_version, t.model_alias,
           (t.title IS NULL AND NOT t.title_locked) AS untitled, l.user_id
      FROM threads t
      LEFT JOIN sandbox_run_leases l
        ON l.team_id = t.team_id AND l.run_id = ${runId} AND l.thread_id = t.id
     WHERE t.team_id = ${teamId} AND t.id = ${threadId}`);
  const thread = res.rows[0];
  if (!thread?.untitled || thread.user_id === null) return undefined;
  const pinned = await agents.pinnedModel?.(tx, {
    teamId,
    ownerUserId: thread.owner_user_id,
    threadId,
    agentScope: thread.agent_scope,
    agentId: thread.agent_id,
    agentVersion: thread.agent_version,
  });
  const resolution = await resolveRunModel(tx, teamId, pinned ?? thread.model_alias ?? undefined);
  if (!resolution.ok || resolution.model === undefined) return undefined;
  const first = await firstUserMessage(tx, teamId, threadId);
  if (!first || first.text === "") return undefined;
  const answer = await firstAnswerAfter(tx, teamId, threadId, first.seq);
  return {
    userId: thread.user_id,
    model: resolution.model.gateway_model,
    messages: titleMessages(first.text, answer),
  };
}
