import {
  rememberScopeSchema,
  type ArgPattern,
  type RememberLimits,
  type RememberScope,
  type ToolRegistry,
} from "@kobe/protocol";
import { sql, SYSTEM_ACTOR, withTeam, type AuditActor, type KobeDb, type KobeTx } from "@kobe/db";
import { liveUserRule } from "./live-rule.js";
import { readTeamRememberLimits } from "./remember-limits-store.js";
import { RULE_REFUSAL_TEXT, rememberedRuleRefusal } from "./remember-limits.js";
import { auditRule, type StoredRule } from "./rule-store.js";

/**
 * Members' remembered approvals (user rules in `tool_rules`, KOBE-289): the liveness rule the
 * engine's rule source shares, and the lists and revokes of the member's Approvals page and the
 * team Policy page. All under the team's RLS (`withTeam`); a member sees and revokes only their
 * own rules, a team admin any member's in their own team.
 */

/** A remembered approval as the Approvals pages show it. */
export interface MemberRuleView {
  readonly id: string;
  readonly user_id: string;
  /** The member's name (team Policy page). */
  readonly user_name: string;
  readonly tool_glob: string;
  /** The exact-action pattern; null for any input, or when `masked`. */
  readonly arg_pattern: ArgPattern | null;
  /** The pattern's pointers (its shape), shown even when the values are masked. */
  readonly arg_pointers: readonly string[];
  readonly remember_scope: RememberScope;
  /** The conversation a `thread` rule holds in; null when `masked`. */
  readonly thread_id: string | null;
  /** Its title (null: untitled, or `masked`). */
  readonly thread_title: string | null;
  readonly run_id: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  /**
   * The team Policy page (D18, review S6): a member's thread and argument values are private
   * unless the thread is shared, so a team admin sees only the tool, scope, pattern shape and
   * expiry ("a conversation").
   */
  readonly masked: boolean;
  /** False when the engine ignores the rule (destructive tool, the team's limits); see `ended_reason`. */
  readonly applies: boolean;
  readonly ended_reason: string | null;
}

type Row = {
  id: string;
  user_id: string;
  user_name: string;
  tool_glob: string;
  arg_pattern: ArgPattern | null;
  remember_scope: string;
  thread_id: string | null;
  thread_title: string | null;
  thread_shared: boolean | null;
  run_id: string | null;
  created_at: Date | string;
  expires_at: Date | string | null;
  last_used_at: Date | string | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : iso(v));

/** What judging a rule needs: the server's tool registry (risk and source of the tool). */
export interface RuleJudge {
  readonly registry: ToolRegistry;
}

async function view(
  row: Row,
  forAdmin: boolean,
  judge: RuleJudge,
  teamId: string,
  limits: RememberLimits,
  now: Date,
): Promise<MemberRuleView | undefined> {
  const scope = rememberScopeSchema.safeParse(row.remember_scope);
  if (!scope.success) return undefined;
  // An admin sees a member's values only for a thread shared with them (team or project share).
  const masked = forAdmin && row.thread_shared !== true;
  const tool = await judge.registry.resolve(teamId, row.tool_glob);
  const refusal =
    tool === undefined
      ? "gone"
      : rememberedRuleRefusal(
          {
            id: row.id,
            scope: "user",
            effect: "allow",
            tool_glob: row.tool_glob,
            ...(row.arg_pattern === null ? {} : { arg_pattern: row.arg_pattern }),
            remember_scope: scope.data,
            created_at: iso(row.created_at),
          },
          tool,
          limits,
          now,
        );
  return {
    id: row.id,
    user_id: row.user_id,
    user_name: row.user_name,
    tool_glob: row.tool_glob,
    arg_pattern: masked ? null : row.arg_pattern,
    arg_pointers: row.arg_pattern === null ? [] : Object.keys(row.arg_pattern).sort(),
    remember_scope: scope.data,
    thread_id: masked ? null : row.thread_id,
    thread_title: masked ? null : row.thread_title,
    run_id: masked ? null : row.run_id,
    created_at: iso(row.created_at),
    expires_at: isoOrNull(row.expires_at),
    last_used_at: isoOrNull(row.last_used_at),
    masked,
    applies: refusal === undefined,
    ended_reason:
      refusal === undefined
        ? null
        : refusal === "gone"
          ? "This tool is no longer available."
          : RULE_REFUSAL_TEXT[refusal],
  };
}

/** Live user rules in the team, of one member (`userId`) or of every member (team admins). */
async function listLive(
  db: KobeDb,
  teamId: string,
  userId: string | undefined,
  judge: RuleJudge,
  now: Date,
): Promise<MemberRuleView[]> {
  const { rows, limits } = await withTeam(db, teamId, async (tx) => ({
    rows: await tx.execute<Row>(sql`
      SELECT tool_rules.id, tool_rules.user_id, u.name AS user_name, tool_rules.tool_glob,
             tool_rules.arg_pattern, tool_rules.remember_scope, tool_rules.thread_id,
             t.title AS thread_title, (t.shared_to_team OR t.shared_to_project) AS thread_shared,
             tool_rules.run_id, tool_rules.created_at, tool_rules.expires_at,
             tool_rules.last_used_at
        FROM tool_rules
        JOIN users u ON u.id = tool_rules.user_id
        LEFT JOIN threads t ON t.team_id = tool_rules.team_id AND t.id = tool_rules.thread_id
       WHERE tool_rules.team_id = ${teamId} AND tool_rules.scope = 'user'
         ${userId === undefined ? sql`` : sql`AND tool_rules.user_id = ${userId}::uuid`}
         AND ${liveUserRule(now)}
       ORDER BY tool_rules.created_at DESC, tool_rules.id DESC
       LIMIT 1000`),
    limits: (await readTeamRememberLimits(tx, teamId)).effective,
  }));
  const views = await Promise.all(
    rows.rows.map((r) => view(r, userId === undefined, judge, teamId, limits, now)),
  );
  return views.flatMap((v) => v ?? []);
}

/** The member's own live remembered approvals (My area, Approvals), each judged as the engine would. */
export function listUserRules(
  db: KobeDb,
  teamId: string,
  userId: string,
  judge: RuleJudge,
  now: Date = new Date(),
): Promise<MemberRuleView[]> {
  return listLive(db, teamId, userId, judge, now);
}

/**
 * Every member's live remembered approvals in the team (team Policy page; team admins), masked:
 * no thread title or argument values unless the thread is shared (D18).
 */
export function listMemberRules(
  db: KobeDb,
  teamId: string,
  judge: RuleJudge,
  now: Date = new Date(),
): Promise<MemberRuleView[]> {
  return listLive(db, teamId, undefined, judge, now);
}

/** Deletes one user rule in the team (only `userId`'s when given), audited; false if none. */
async function deleteOne(
  tx: KobeTx,
  teamId: string,
  id: string,
  userId: string | undefined,
  actor?: AuditActor,
): Promise<boolean> {
  const res = await tx.execute<{ id: string }>(sql`
    DELETE FROM tool_rules
     WHERE team_id = ${teamId} AND id = ${id}::uuid AND scope = 'user'
       ${userId === undefined ? sql`` : sql`AND user_id = ${userId}::uuid`}
     RETURNING *`);
  const row = res.rows[0] as unknown as RawRule | undefined;
  if (!row) return false;
  await auditRule(tx, "policy.rule.deleted", storedFromRaw(row), teamId, actor);
  return true;
}

/**
 * Revokes one of the caller's own remember-rules (D29: revocable in settings). Takes effect at
 * once: the engine reads rules per decision.
 */
export function deleteUserRule(
  db: KobeDb,
  teamId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  return withTeam(db, teamId, (tx) => deleteOne(tx, teamId, id, userId));
}

/** A team admin revokes any member's remember-rule in their own team (RLS keeps it there). */
export function deleteMemberRule(db: KobeDb, teamId: string, id: string): Promise<boolean> {
  return withTeam(db, teamId, (tx) => deleteOne(tx, teamId, id, undefined));
}

/**
 * Removes the member's rules that no longer hold (expired, or their thread or run is gone), so
 * ended `run` and `thread` rules don't fill the member's rule cap. Each is audited as deleted by
 * the system. Called before a new rule is counted against the cap.
 */
export async function pruneEndedUserRules(
  tx: KobeTx,
  teamId: string,
  userId: string,
  now: Date,
): Promise<number> {
  const res = await tx.execute(sql`
    DELETE FROM tool_rules
     WHERE team_id = ${teamId} AND scope = 'user' AND user_id = ${userId}::uuid
       AND NOT ${liveUserRule(now)}
     RETURNING *`);
  for (const row of res.rows as unknown as RawRule[]) {
    await auditRule(tx, "policy.rule.deleted", storedFromRaw(row), teamId, SYSTEM_ACTOR);
  }
  return res.rows.length;
}

async function auditEnded(tx: KobeTx, teamId: string, rows: readonly RawRule[]): Promise<number> {
  for (const row of rows) {
    await auditRule(tx, "policy.rule.deleted", storedFromRaw(row), teamId, SYSTEM_ACTOR);
  }
  return rows.length;
}

/**
 * Ends "this conversation" rules for good (KOBE-289 review S2) when their thread is archived,
 * moved to Trash or moved to another project: the rows are deleted, each audited as deleted by the
 * system, in the caller's transaction. Unarchiving, restoring or moving the thread back never
 * brings them back.
 */
export async function endThreadRules(
  tx: KobeTx,
  teamId: string,
  threadIds: readonly string[],
): Promise<number> {
  if (threadIds.length === 0) return 0;
  const res = await tx.execute(sql`
    DELETE FROM tool_rules
     WHERE team_id = ${teamId} AND scope = 'user'
       AND thread_id = ANY(${`{${threadIds.join(",")}}`}::uuid[])
     RETURNING *`);
  return auditEnded(tx, teamId, res.rows as unknown as RawRule[]);
}

/**
 * Ends the team's thread rules whose member can no longer open the thread (removed from its
 * project, the project made selected-members, no longer team admin): deleted and audited, so
 * regaining access never brings them back (review S2).
 */
export async function endUnreachableThreadRules(
  tx: KobeTx,
  teamId: string,
  now: Date = new Date(),
): Promise<number> {
  const res = await tx.execute(sql`
    DELETE FROM tool_rules
     WHERE team_id = ${teamId} AND scope = 'user' AND thread_id IS NOT NULL
       AND NOT ${liveUserRule(now)}
     RETURNING *`);
  return auditEnded(tx, teamId, res.rows as unknown as RawRule[]);
}

/** A `tool_rules` row as raw SQL returns it (snake_case). */
interface RawRule {
  id: string;
  team_id: string;
  scope: "team" | "user";
  user_id: string | null;
  effect: "deny" | "ask" | "allow";
  tool_glob: string;
  arg_pattern: ArgPattern | null;
  note: string | null;
  created_by: string;
  created_at: Date | string;
  expires_at: Date | string | null;
  remember_scope: string | null;
  thread_id: string | null;
  run_id: string | null;
  last_used_at: Date | string | null;
}

function storedFromRaw(row: RawRule): StoredRule {
  const scope = rememberScopeSchema.safeParse(row.remember_scope);
  return {
    id: row.id,
    scope: row.scope,
    scope_ref: row.scope === "team" ? row.team_id : row.user_id,
    effect: row.effect,
    tool_glob: row.tool_glob,
    arg_pattern: row.arg_pattern,
    note: row.note,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    expires_at: isoOrNull(row.expires_at),
    ...(scope.success ? { remember_scope: scope.data } : {}),
    ...(row.thread_id ? { thread_id: row.thread_id } : {}),
    ...(row.run_id ? { run_id: row.run_id } : {}),
    last_used_at: isoOrNull(row.last_used_at),
  };
}
