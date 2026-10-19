import { Hono } from "hono";
import { z } from "zod";
import {
  approvalResolutionCauseSchema,
  idSchema,
  uuidSchema as wireUuidSchema,
} from "@kobe/protocol";
import { RUN_SKILL_SOURCES, sql, withTeam, type KobeTx, type RunSkillRef } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { skillUpdatesOf } from "../skills/usage.js";
import { invalidRequest } from "../teams/http.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";
import { projectMarkers, projectMarkerSchema } from "../threads/project-moves.js";
import { agentMarkers, agentMarkerSchema } from "../threads/agent-switches.js";

/** Most rows of each kind one answer carries (newest kept; a thread rarely has more). */
export const MAX_MARKERS = 500;

const runMarkerSchema = z.strictObject({
  run_id: wireUuidSchema,
  /** How a message run that started ended without finishing (KOBE-290 adds Stop and failures). */
  status: z.enum(["interrupted", "budget_stopped", "cancelled", "failed"]),
  /** A failed run's message: the server's own text for its failure code (never the sandbox's). */
  message: z.string().optional(),
  /** The prompt the run answered (Pi entry id), once mirrored; null if it never was. */
  user_entry_id: idSchema.nullable(),
  /** Where the run continued from; places a run whose prompt never reached the tree. */
  parent_entry_id: idSchema.nullable(),
});

const approvalMarkerSchema = z.strictObject({
  approval_id: wireUuidSchema,
  run_id: wireUuidSchema,
  /** The run's prompt entry: tool call ids are only unique per run, so it places the marker. */
  user_entry_id: idSchema.nullable(),
  tool_call_id: z.string(),
  status: z.enum(["allowed", "denied", "expired"]),
  /** Why it left pending: `user` decided, or the TTL, or the run ended (cancelled, …). */
  cause: approvalResolutionCauseSchema.nullable(),
});

const skillMarkerSchema = z.strictObject({
  run_id: wireUuidSchema,
  /** The run's prompt entry: places the badge with the tool call, like an approval's marker. */
  user_entry_id: idSchema.nullable(),
  /** The `read` call that loaded the skill's SKILL.md (matched by the server, KOBE-297). */
  tool_call_id: z.string(),
  /** The skill's name as the server listed it in the run's `run.start`. */
  name: z.string(),
  source: z.enum(RUN_SKILL_SOURCES),
  /** The version the run loaded (KOBE-315); absent for built-ins and runs recorded before. */
  semver: z.string().optional(),
});

/** CE12 (KOBE-315): a run loaded a skill at another version than the thread's previous run. */
const skillUpdateMarkerSchema = z.strictObject({
  run_id: wireUuidSchema,
  /** The run's prompt entry: the marker goes before its answer. */
  user_entry_id: idSchema.nullable(),
  name: z.string(),
  from: z.string(),
  to: z.string(),
});

export const threadMarkersSchema = z.strictObject({
  runs: z.array(runMarkerSchema),
  approvals: z.array(approvalMarkerSchema),
  /** Skills the thread's runs used (KOBE-297): "Used skill" on the answer, "Read skill" on the step. */
  skills: z.array(skillMarkerSchema),
  /** "Skill updated: xlsx 1.4.2 → 1.4.3" (KOBE-315, CE12), on the first run with the new version. */
  skill_updates: z.array(skillUpdateMarkerSchema),
  /**
   * Moves to another project (CE19, KOBE-220), each on the first run that started after it: the
   * project's context applies from there. At most one per run, at most 20.
   */
  projects: z.array(projectMarkerSchema),
  /**
   * Where the agent version changed between the thread's runs (U8, KOBE-420, `runs.agent_version`),
   * each on the first run on the new version. At most one per run.
   */
  agents: z.array(agentMarkerSchema),
  /** True when a list held more than {@link MAX_MARKERS}: only the newest are returned. */
  truncated: z.boolean(),
});
export type ThreadMarkers = z.infer<typeof threadMarkersSchema>;

type Row = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The newest {@link MAX_MARKERS} rows, oldest first, and whether there were more. */
function newest(rows: readonly Row[]): { rows: Row[]; truncated: boolean } {
  return { rows: rows.slice(0, MAX_MARKERS).reverse(), truncated: rows.length > MAX_MARKERS };
}

type RunMarkerStatus = z.infer<typeof runMarkerSchema>["status"];

async function runMarkers(tx: KobeTx, teamId: string, threadId: string) {
  // Stopped and failed only once started: a deleted or never-started queued message is no turn.
  const res = await tx.execute<Row>(sql`
    SELECT r.id, r.status, r.user_entry_id, r.parent_entry_id, f.message
      FROM runs r
      LEFT JOIN LATERAL (
        SELECT e.payload -> 'error' ->> 'message' AS message FROM run_events e
         WHERE e.team_id = r.team_id AND e.run_id = r.id AND r.status = 'failed'
           AND e.type = 'run.failed'
         ORDER BY e.seq DESC LIMIT 1) f ON true
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid AND r.kind = 'message'
       AND (r.status IN ('interrupted', 'budget_stopped')
            OR (r.status IN ('cancelled', 'failed') AND r.started_at IS NOT NULL))
     ORDER BY r.created_at DESC, r.id DESC LIMIT ${MAX_MARKERS + 1}`);
  const { rows, truncated } = newest(res.rows);
  return {
    truncated,
    runs: rows.map((r) => {
      const message = text(r.message);
      return {
        run_id: String(r.id),
        status: r.status as RunMarkerStatus,
        ...(r.status === "failed" && message !== null ? { message } : {}),
        user_entry_id: text(r.user_entry_id),
        parent_entry_id: text(r.parent_entry_id),
      };
    }),
  };
}

/**
 * Decided approvals of the thread whose asker is `userId` (the run's user, KOBE-37). Reached
 * through the thread's runs (`runs_thread_idx`, then `approvals_tool_call_key`'s
 * `(team_id, run_id)` prefix): `approvals` has no thread index, and the user's index would read
 * every approval they ever had in the team.
 */
async function approvalMarkers(tx: KobeTx, teamId: string, threadId: string, userId: string) {
  const res = await tx.execute<Row>(sql`
    SELECT a.id, a.run_id, r.user_entry_id, a.tool_call_id, a.status, a.cause
      FROM runs r
      JOIN approvals a ON a.team_id = r.team_id AND a.run_id = r.id
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
       AND a.team_id = ${teamId}::uuid AND a.thread_id = ${threadId}::uuid
       AND a.user_id = ${userId}::uuid AND a.status <> 'pending'
     ORDER BY a.created_at DESC, a.id DESC LIMIT ${MAX_MARKERS + 1}`);
  const { rows, truncated } = newest(res.rows);
  return {
    truncated,
    approvals: rows.map((r) => {
      const cause = approvalResolutionCauseSchema.safeParse(r.cause);
      return {
        approval_id: String(r.id),
        run_id: String(r.run_id),
        user_entry_id: text(r.user_entry_id),
        tool_call_id: String(r.tool_call_id),
        status: r.status as "allowed" | "denied" | "expired",
        cause: cause.success ? cause.data : null,
      };
    }),
  };
}

/** Skill uses the server recorded on the thread's runs (`runs.skills_used`, KOBE-297). */
async function skillMarkers(tx: KobeTx, teamId: string, threadId: string) {
  const res = await tx.execute<Row>(sql`
    SELECT r.id, r.user_entry_id, u.use ->> 'tool_call_id' AS tool_call_id,
           u.use ->> 'name' AS name, u.use ->> 'source' AS source,
           (SELECT ref ->> 'semver' FROM jsonb_array_elements(r.skill_refs) AS ref
             WHERE ref ->> 'name' = u.use ->> 'name' AND ref ->> 'source' = u.use ->> 'source'
             LIMIT 1) AS semver
      FROM runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.skills_used) WITH ORDINALITY AS u(use, n)
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
       AND jsonb_array_length(r.skills_used) > 0
     ORDER BY r.created_at DESC, r.id DESC, u.n DESC LIMIT ${MAX_MARKERS + 1}`);
  const { rows, truncated } = newest(res.rows);
  return {
    truncated,
    skills: rows.flatMap((r) => {
      const toolCallId = text(r.tool_call_id);
      const name = text(r.name);
      const source = skillMarkerSchema.shape.source.safeParse(r.source);
      const semver = text(r.semver);
      if (toolCallId === null || name === null || !source.success) return [];
      return [
        {
          run_id: String(r.id),
          user_entry_id: text(r.user_entry_id),
          tool_call_id: toolCallId,
          name,
          source: source.data,
          ...(semver === null ? {} : { semver }),
        },
      ];
    }),
  };
}

/**
 * "Skill updated" markers (KOBE-315, CE12), derived from the runs' recorded skills
 * (`runs.skill_refs`, durable unlike the event stream): walking the thread's started runs oldest
 * first, a run that loads a skill at another version than the last run that loaded it.
 */
async function skillUpdateMarkers(tx: KobeTx, teamId: string, threadId: string) {
  const res = await tx.execute<{ id: string; user_entry_id: string | null; refs: RunSkillRef[] }>(
    sql`
    SELECT r.id, r.user_entry_id, r.skill_refs AS refs
      FROM runs r
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
       AND r.started_at IS NOT NULL AND jsonb_array_length(r.skill_refs) > 0
     ORDER BY r.started_at, r.created_at, r.id`,
  );
  const markers: z.infer<typeof skillUpdateMarkerSchema>[] = [];
  const earlier: RunSkillRef[][] = [];
  for (const run of res.rows) {
    for (const u of skillUpdatesOf(earlier, run.refs))
      markers.push({ run_id: run.id, user_entry_id: run.user_entry_id, ...u });
    earlier.unshift(run.refs);
  }
  return {
    truncated: markers.length > MAX_MARKERS,
    skillUpdates: markers.slice(-MAX_MARKERS),
  };
}

/**
 * `GET /v1/threads/{id}/markers` (KOBE-209, CE12/CE16): what the chat marks between messages that
 * the entry tree doesn't hold: runs that ended `interrupted` or `budget_stopped`, or that started
 * and were stopped (`cancelled`) or failed (KOBE-290), decided
 * approvals (outcome and cause only, never the checked input or reasons), and the skills its runs
 * used (KOBE-297, to everyone who sees the thread, like the tool calls themselves), its moves to
 * another project (KOBE-220) and switches of its agent version (KOBE-420). Newest 500 of each,
 * oldest first; `truncated` says older ones were left out. Visible like the thread
 * (`findThread`); approvals only to the run's user, as `GET /v1/approvals` (a reader of a shared
 * thread gets none). Team-scoped under RLS. Reads Postgres only; never wakes a sandbox.
 */
export function threadMarkerRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/:id/markers", async (c) => {
    const parsed = uuidSchema.safeParse(c.req.param("id"));
    if (!parsed.success) return invalidRequest(c);
    const threadId = parsed.data;
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const body = await withTeam(deps.database.db, teamId, async (tx) => {
      const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
      if (!(await findThread(tx, viewer, threadId))) return null;
      const runs = await runMarkers(tx, teamId, threadId);
      const approvals = await approvalMarkers(tx, teamId, threadId, userId);
      const skills = await skillMarkers(tx, teamId, threadId);
      const updates = await skillUpdateMarkers(tx, teamId, threadId);
      return {
        runs: runs.runs,
        approvals: approvals.approvals,
        skills: skills.skills,
        skill_updates: updates.skillUpdates,
        projects: await projectMarkers(tx, viewer, threadId),
        agents: await agentMarkers(tx, teamId, threadId),
        truncated: runs.truncated || approvals.truncated || skills.truncated || updates.truncated,
      } satisfies ThreadMarkers;
    });
    if (!body) return c.json({ code: "thread_not_found", message: "No thread with that id." }, 404);
    return c.json(body);
  });

  return app;
}
