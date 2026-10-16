import { RUN_SKILL_USES_MAX, sql, type KobeTx, type RunSkillRef, type RunSkillUse } from "@kobe/db";
import { matchSkillRead, skillUsesFrom } from "./detect.js";

/**
 * Skill use, stored (KOBE-297). Both lists live on the run row: `skill_refs` is written with
 * `run.start`, `skills_used` by the ingest in the same transaction that appends the matching
 * `tool.result` (it already holds the run row there). Run rows outlive the event stream (D18
 * compacts `run_events` after 7 days), so the chat's badge and the per-skill usage below stay.
 */

/** Results per batch whose earlier call is looked up (a sandbox can't make a batch scan more). */
const MAX_LOOKUPS = 32;

/** Records the skills a run was started with. `replace`: a recovery restart re-resolved them. */
export async function recordRunSkillRefsInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  refs: readonly RunSkillRef[],
  replace = false,
): Promise<void> {
  if (refs.length === 0 && !replace) return; // the column's default is already `[]`
  await tx.execute(sql`
    UPDATE runs SET skill_refs = ${JSON.stringify(refs)}::jsonb
     WHERE team_id = ${teamId} AND id = ${runId}`);
}

/**
 * Adds the skill uses in `events` (a batch the ingest is appending) to the run. Reads the run's
 * own refs; a successful read whose call came in an earlier batch is matched from that call's
 * stored `tool.call` input. Each tool call counts once, at most {@link RUN_SKILL_USES_MAX} per run.
 */
export async function recordSkillUsesInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  events: readonly { readonly type: string; readonly payload: unknown }[],
): Promise<readonly RunSkillUse[]> {
  if (!events.some(isReadSuccess)) return [];
  const res = await tx.execute<{ refs: RunSkillRef[]; used: RunSkillUse[] }>(sql`
    SELECT skill_refs AS refs, skills_used AS used FROM runs
     WHERE team_id = ${teamId} AND id = ${runId}`);
  const row = res.rows[0];
  if (!row || row.refs.length === 0) return [];
  const found = skillUsesFrom(events, row.refs);
  const uses = [
    ...found.uses,
    ...(await earlierCalls(tx, teamId, runId, found.unresolved.slice(0, MAX_LOOKUPS), row.refs)),
  ];
  const known = new Set(row.used.map((u) => u.tool_call_id));
  const added = uses.filter((u) => !known.has(u.tool_call_id));
  const room = RUN_SKILL_USES_MAX - row.used.length;
  if (added.length === 0 || room <= 0) return [];
  const kept = added.slice(0, room);
  await tx.execute(sql`
    UPDATE runs SET skills_used = skills_used || ${JSON.stringify(kept)}::jsonb
     WHERE team_id = ${teamId} AND id = ${runId}`);
  return kept;
}

function isReadSuccess(e: { readonly type: string; readonly payload: unknown }): boolean {
  const p = e.payload as { tool?: unknown; is_error?: unknown } | null;
  return e.type === "tool.result" && p?.tool === "read" && p.is_error === false;
}

/** Uses among results whose `tool.call` is already in `run_events` (an earlier batch). */
async function earlierCalls(
  tx: KobeTx,
  teamId: string,
  runId: string,
  toolCallIds: readonly string[],
  refs: readonly RunSkillRef[],
): Promise<RunSkillUse[]> {
  if (toolCallIds.length === 0) return [];
  const res = await tx.execute<{ id: string; input: unknown }>(sql`
    SELECT payload->>'tool_call_id' AS id, payload->'input' AS input FROM run_events
     WHERE team_id = ${teamId} AND run_id = ${runId} AND type = 'tool.call'
       AND payload->>'tool' = 'read'
       AND payload->>'tool_call_id' IN (${sql.join(
         toolCallIds.map((id) => sql`${id}`),
         sql`, `,
       )})`);
  const uses: RunSkillUse[] = [];
  const seen = new Set<string>();
  for (const r of res.rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const ref = matchSkillRead("read", r.input, refs);
    if (ref) uses.push({ tool_call_id: r.id, name: ref.name, source: ref.source });
  }
  return uses;
}

/**
 * Usage covers this many days of runs (KOBE-297 review M1): the read uses `runs_skill_uses_idx`
 * (migration 0102: team_id, created_at, where a run used a skill) and never scans the team's runs.
 */
export const SKILL_USAGE_DAYS = 90;

/** One agent a skill was used by: null id = runs with no agent. */
export interface SkillUsageAgent {
  readonly agentId: string | null;
  readonly uses: number;
}

export interface SkillUsage {
  readonly uses: number;
  readonly lastUsedAt: Date | null;
  readonly agents: readonly SkillUsageAgent[];
}

type UsageSkill = {
  readonly source: "team" | "personal";
  readonly name: string;
  readonly ownerUserId?: string;
};

/**
 * The usage read (exported so a test can EXPLAIN it): the team's runs of the window that used a
 * skill, through `runs_skill_uses_idx` (its predicate is repeated here word for word).
 */
export function skillUsageQuery(teamId: string, skill: UsageSkill) {
  const owner =
    skill.source === "personal" && skill.ownerUserId !== undefined
      ? sql`AND t.owner_user_id = ${skill.ownerUserId}::uuid`
      : sql``;
  return sql`
    SELECT t.agent_id, count(*) AS uses, max(coalesce(r.ended_at, r.started_at, r.created_at)) AS last
      FROM runs r
      JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
      CROSS JOIN LATERAL jsonb_array_elements(r.skills_used) AS u(use)
     WHERE r.team_id = ${teamId} AND t.team_id = ${teamId}
       AND jsonb_array_length(r.skills_used) > 0
       AND r.created_at > now() - make_interval(days => ${SKILL_USAGE_DAYS})
       AND u.use->>'source' = ${skill.source} AND u.use->>'name' = ${skill.name}
       ${owner}
     GROUP BY t.agent_id
     ORDER BY count(*) DESC`;
}

/**
 * How often a skill was used in this team in the last {@link SKILL_USAGE_DAYS} days (KOBE-297):
 * uses (SKILL.md reads), the last one, and by which agents. A team skill counts every member's
 * runs; a personal one only `ownerUserId`'s (nobody else's runs can carry it). Reads run rows of
 * the team (RLS and an explicit team filter).
 */
export async function skillUsageInTx(
  tx: KobeTx,
  teamId: string,
  skill: UsageSkill,
): Promise<SkillUsage> {
  const res = await tx.execute<{ agent_id: string | null; uses: string; last: Date | string }>(
    skillUsageQuery(teamId, skill),
  );
  let uses = 0;
  let last: Date | null = null;
  const agents: SkillUsageAgent[] = [];
  for (const r of res.rows) {
    const n = Number(r.uses);
    uses += n;
    const at = new Date(r.last);
    if (last === null || at > last) last = at;
    agents.push({ agentId: r.agent_id, uses: n });
  }
  return { uses, lastUsedAt: last, agents };
}
