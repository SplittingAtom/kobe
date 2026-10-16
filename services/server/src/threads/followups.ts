import {
  SERVER_CALL_LIMITS,
  THREAD_SUGGESTION_MAX_CHARS,
  THREAD_SUGGESTIONS_MAX,
  threadSuggestionsSchema,
  type ServerCallRequest,
} from "@kobe/protocol";
import {
  loadMemberBudgetState,
  sql,
  thresholdReached,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { RunAgentResolver } from "../runs/seams.js";
import { cutText, lastExchange } from "./messages.js";
import { loadServerCallTarget, type TitleSource } from "./title-source.js";
import { LINES, LINKISH, QUOTES, UNSAFE } from "./title.js";

/**
 * Follow-up suggestions (CE21, KOBE-222) on the KOBE-234 contract (docs/design/server-model-calls.md),
 * the same path as KOBE-219's titles: after a completed message run, when the team turned them on,
 * the server asks the thread's model for up to three one-line follow-ups and appends them to the
 * run as `thread.suggestions`. The web shows them as chips above the composer until the next send.
 * Off by default; a team admin turns them on (`/v1/team/settings`).
 */

/** The `teams.settings` key of the team switch (no migration: `teams.settings` is jsonb). */
export const TEAM_FOLLOWUPS_SETTING = "followups_enabled";
/** What the prompt quotes of the last message and of its answer. */
export const FOLLOWUP_QUOTE_CHARS = 2_000;

const SYSTEM_PROMPT =
  "You suggest what the user could send next in the conversation below. Reply with exactly " +
  "three short follow-up questions or requests, written as the user would type them: one per " +
  "line, plain text, no numbering, no quotes, each under 100 characters, in the language of the " +
  "user's message.";

/** Whether the team turned follow-ups on (default off). `teams` is a site table: by id. */
export async function readFollowupsEnabled(db: KobeDb | KobeTx, teamId: string): Promise<boolean> {
  const res = await db.execute<{ on: boolean | null }>(sql`
    SELECT (settings -> ${TEAM_FOLLOWUPS_SETTING}) = 'true'::jsonb AS on
      FROM teams WHERE id = ${teamId}`);
  return res.rows[0]?.on === true;
}

/** Turns the team's follow-ups on or off, audited (`models.followups.changed`). */
export async function setFollowupsEnabled(
  db: KobeDb,
  teamId: string,
  enabled: boolean,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE teams
         SET settings = jsonb_set(settings, ${`{${TEAM_FOLLOWUPS_SETTING}}`}::text[],
                                  to_jsonb(${enabled}::boolean))
       WHERE id = ${teamId}
      RETURNING id`);
    if ((res.rowCount ?? 0) === 0) throw new Error("team not found");
    await recordAudit(tx, { action: "models.followups.changed", teamId, target: { enabled } });
    return enabled;
  });
}

/**
 * In the transaction that completes the run (KOBE-234 Flow 1): whether `run.completed` announces
 * follow-ups. This server can make the call, the team switch is on, the run is a completed message
 * run a member started (not a schedule) on a thread that is no builder test thread and not in
 * Trash, and no budget line of the run's member (site, team, theirs) is at
 * `SERVER_CALL_LIMITS.followups.skip_at_percent` (80 %) or more. The gateway enforces the 80 %
 * rule again (402 `budget_soft_limit`).
 */
export async function followupsDecisionInTx(
  tx: KobeTx,
  ids: { readonly teamId: string; readonly runId: string; readonly threadId: string },
  canCall: boolean,
): Promise<boolean> {
  if (!canCall) return false;
  const { teamId, runId, threadId } = ids;
  if (!(await readFollowupsEnabled(tx, teamId))) return false;
  const res = await tx.execute<{ eligible: boolean; user_id: string | null }>(sql`
    SELECT (NOT t.is_test AND t.deleted_at IS NULL AND r.kind = 'message'
            AND r.status = 'completed' AND r.trigger = 'user') AS eligible,
           l.user_id
      FROM threads t
      JOIN runs r ON r.team_id = t.team_id AND r.thread_id = t.id
      LEFT JOIN sandbox_run_leases l ON l.team_id = r.team_id AND l.run_id = r.id
     WHERE t.team_id = ${teamId} AND t.id = ${threadId} AND r.id = ${runId}`);
  const row = res.rows[0];
  if (row?.eligible !== true || !row.user_id) return false;
  const budget = await loadMemberBudgetState(tx, teamId, row.user_id);
  const skipAt = SERVER_CALL_LIMITS.followups.skip_at_percent;
  return !budget.lines.some((line) => thresholdReached(line, skipAt));
}

/** The follow-up request's messages: the last user message and its answer, quoted. */
export function followupMessages(
  prompt: string,
  answer: string | undefined,
): ServerCallRequest["messages"] {
  const quoted = [
    `Last message:\n${cutText(prompt, FOLLOWUP_QUOTE_CHARS)}`,
    ...(answer ? [`Answer:\n${cutText(answer, FOLLOWUP_QUOTE_CHARS)}`] : []),
  ].join("\n\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: quoted },
  ];
}

const BULLET = /^(?:[-*•–]+|\d{1,2}[.):]|[a-z][.)])\s+/iu;
const MARKUP = /^[#>*_\s]+|[*_\s]+$/gu;
/** A suggestion says something: at least one letter or digit. */
const WORDY = /[\p{L}\p{N}]/u;

/** One reply line as a suggestion: no bullet, number, quotes or Markdown; undefined if unusable. */
function suggestionOf(line: string): string | undefined {
  let text = line.replace(/\t/gu, " ").replace(UNSAFE, "").trim();
  for (let i = 0; i < 3; i += 1) {
    text = text.replace(MARKUP, "").replace(BULLET, "").replace(QUOTES, "").trim();
  }
  text = text.replace(/\s+/gu, " ");
  if (!WORDY.test(text) || LINKISH.test(text) || text.length > THREAD_SUGGESTION_MAX_CHARS) {
    return undefined;
  }
  return text;
}

/**
 * The model's reply as follow-ups (`threadSuggestionsSchema`): each non-empty line cleaned, lines
 * that are too long or hold a link dropped, duplicates removed, at most three. Undefined when
 * nothing usable is left.
 */
export function parseFollowups(reply: string): readonly string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of reply.split(LINES)) {
    const s = suggestionOf(line);
    if (s === undefined || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length === THREAD_SUGGESTIONS_MAX) break;
  }
  const parsed = threadSuggestionsSchema.safeParse(out);
  return parsed.success ? parsed.data : undefined;
}

export type FollowupsSourceResult =
  | { readonly ok: true; readonly source: TitleSource }
  | { readonly ok: false; readonly reason: "no_thread" | "no_lease" | "no_model" | "no_message" };

/** The follow-up call's member, model and prompt, read at call time (as for titles). */
export async function loadFollowupsSource(
  tx: KobeTx,
  agents: RunAgentResolver,
  ids: { readonly teamId: string; readonly runId: string; readonly threadId: string },
): Promise<FollowupsSourceResult> {
  const loaded = await loadServerCallTarget(tx, agents, ids);
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason === "titled" ? "no_thread" : loaded.reason };
  }
  const exchange = await lastExchange(tx, ids.teamId, ids.threadId);
  if (!exchange) return { ok: false, reason: "no_message" };
  const { userId, model, reasoning } = loaded.target;
  return {
    ok: true,
    source: {
      userId,
      model,
      reasoning,
      messages: followupMessages(exchange.prompt, exchange.answer),
    },
  };
}
