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
import { logger } from "../logger.js";
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

/** The team's settings as an object: a malformed (non-object) value counts as empty. */
const SETTINGS_OBJECT = sql`CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END`;

/**
 * Turns the team's follow-ups on or off, audited (`models.followups.changed`) when it changed. A
 * `teams.settings` that is not an object (never written by Kobe, but not constrained) is replaced
 * by one holding the switch instead of failing.
 */
export async function setFollowupsEnabled(
  db: KobeDb,
  teamId: string,
  enabled: boolean,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const current = await tx.execute<{ on: boolean | null }>(sql`
      SELECT (settings -> ${TEAM_FOLLOWUPS_SETTING}) = 'true'::jsonb AS on
        FROM teams WHERE id = ${teamId} FOR NO KEY UPDATE`);
    const row = current.rows[0];
    if (!row) throw new Error("team not found");
    if ((row.on === true) === enabled) return enabled;
    await tx.execute(sql`
      UPDATE teams
         SET settings = jsonb_set(${SETTINGS_OBJECT}, ${`{${TEAM_FOLLOWUPS_SETTING}}`}::text[],
                                  to_jsonb(${enabled}::boolean))
       WHERE id = ${teamId}`);
    await recordAudit(tx, { action: "models.followups.changed", teamId, target: { enabled } });
    return enabled;
  });
}

type RunIds = { readonly teamId: string; readonly runId: string; readonly threadId: string };

/** The decision's reads (switch, run, budget lines); a parameter so tests can make it fail. */
export type FollowupsCheck = (tx: KobeTx, ids: RunIds) => Promise<boolean>;

/**
 * The team switch is on, the run is a completed message run a member started (not a schedule) on
 * a thread that is no builder test thread and not in Trash, and no budget line of the run's member
 * (site, team or the team's default member budget, theirs) is at
 * `SERVER_CALL_LIMITS.followups.skip_at_percent` (80 %) or more, judged exactly as the gateway
 * judges it (`thresholdReached`). The gateway enforces the 80 % rule again (402
 * `budget_soft_limit`).
 */
export const followupsEligibleInTx: FollowupsCheck = async (tx, { teamId, runId, threadId }) => {
  if (!(await readFollowupsEnabled(tx, teamId))) return false;
  const res = await tx.execute<{ eligible: boolean; user_id: string | null }>(sql`
    SELECT (NOT t.is_test AND NOT t.skill_eval AND t.deleted_at IS NULL AND r.kind = 'message'
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
};

const errorCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.name : "unknown";
};

/**
 * In the transaction that completes the run (KOBE-234 Flow 1): whether `run.completed` announces
 * follow-ups ({@link followupsEligibleInTx}). The reads run in a savepoint and any error means "no
 * follow-ups" (logged with its code): a hint never rolls back the run's completion (review S1).
 */
export async function followupsDecisionInTx(
  tx: KobeTx,
  ids: RunIds,
  canCall: boolean,
  check: FollowupsCheck = followupsEligibleInTx,
): Promise<boolean> {
  if (!canCall) return false;
  try {
    return await tx.transaction((sp) => check(sp, ids));
  } catch (err) {
    logger.warn(
      { purpose: "followups", run_id: ids.runId, code: errorCode(err) },
      "follow-up decision failed; skipped",
    );
    return false;
  }
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
/** Emphasis and code marks inside the line (`**x**`, `__x__`, `` `x` ``, `*x*`, `_x_`). */
const INLINE_MARKUP = /\*\*|__|`|(?<![\p{L}\p{N}])[*_](?=\S)|(?<=\S)[*_](?![\p{L}\p{N}])/gu;
/** A code fence line (with or without a language tag). */
const FENCE = /^\s*(?:```|~~~)/u;
/** A suggestion says something: at least one letter or digit. */
const WORDY = /[\p{L}\p{N}]/u;
/** A lead-in such as "Here are three follow-up questions:" introduces the list; never a chip. */
const LEAD_IN = /[:：]$/u;
/** A bare address or e-mail (review N6): a chip a click turns into the member's own message. */
const ADDRESSISH = /\w\.[a-z]{2,}\/|\S@[\w-]+\.\w{2,}/iu;

/** One reply line as a suggestion: no bullet, number, quotes or Markdown; undefined if unusable. */
function suggestionOf(line: string): string | undefined {
  if (FENCE.test(line)) return undefined;
  let text = line.replace(/\t/gu, " ").replace(UNSAFE, "").trim();
  for (let i = 0; i < 3; i += 1) {
    text = text.replace(MARKUP, "").replace(BULLET, "").replace(QUOTES, "").trim();
  }
  text = text.replace(INLINE_MARKUP, "").replace(/\s+/gu, " ").trim();
  if (
    !WORDY.test(text) ||
    LEAD_IN.test(text) ||
    LINKISH.test(text) ||
    ADDRESSISH.test(text) ||
    text.length > THREAD_SUGGESTION_MAX_CHARS
  ) {
    return undefined;
  }
  return text;
}

/**
 * The model's reply as follow-ups (`threadSuggestionsSchema`): each non-empty line cleaned; code
 * fences, lead-ins ending in a colon, lines that are too long or hold a link or address dropped;
 * duplicates removed; the first three kept. Undefined when nothing usable is left.
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
