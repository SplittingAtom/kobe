import { sql, type KobeTx } from "@kobe/db";
import { agentMemorySettingSchema, type AgentMemorySetting } from "@kobe/protocol";

/**
 * What memory a run gets from its agent version's memory setting (KOBE-646, v1.3 SM23, Chris
 * Q3). Always the **runner's** memory (the run's user), never the agent owner's: agents are not a
 * memory scope. The one place run assembly asks; KOBE-382/383/399 read `semantic` for the "What
 * Kobe knows" block and item recall.
 *
 * - `all` → Notes (`run.start.memory`, `remember`/`recall`) and semantic memory.
 * - `notes_only` → Notes and Site Policy only.
 * - `off` → no Notes (the memory tools withheld) and no memories except Site Policy, which
 *   reaches every run (Chris 2026-11-13); `run.start.memory` then carries only Policy.
 *
 * Isolated runs keep today's rules whatever the setting: a skill eval (KOBE-325) gets no memory;
 * a builder test chat (KOBE-85, `threads.is_test`) runs its draft with the current version's
 * setting for Notes but never gets semantic memory.
 */
export interface RunMemoryPlan {
  readonly setting: AgentMemorySetting;
  /** `run.start.memory` (Notes) and the `remember` / `recall` tools. */
  readonly notes: boolean;
  /** `run.start.memory.semantic` and item recall (applied by KOBE-382/383/399). */
  readonly semantic: boolean;
  /**
   * Site Policy in `run.start.memory.semantic`, whatever the setting (Chris 2026-11-13, review
   * Info 1): `notes_only` and `off` drop every other memory, never Policy; only the Site master
   * switch stops it. Isolated runs (test chats, skill evals) get none.
   */
  readonly policy: boolean;
}

export type RunIsolation = "none" | "test_chat" | "skill_eval";

export function memoryPlan(
  setting: AgentMemorySetting,
  isolation: RunIsolation = "none",
): RunMemoryPlan {
  return {
    setting,
    notes: setting !== "off" && isolation !== "skill_eval",
    semantic: setting === "all" && isolation === "none",
    policy: isolation === "none",
  };
}

interface PlanRow extends Record<string, unknown> {
  readonly is_test: boolean;
  readonly skill_eval: boolean;
  readonly memory: string;
}

/**
 * The plan of run `runId`, read inside the run's team transaction. The setting is the memory of
 * the version the run uses (`runs.agent_version`, else the thread's pin); a test chat (no version)
 * takes the agent's current version's, `all` before its first publish; no agent is `all`. Throws
 * for an unknown run or an unreadable setting (callers fail closed: no memory).
 */
export async function readRunMemoryPlan(
  tx: KobeTx,
  run: { readonly teamId: string; readonly runId: string },
): Promise<RunMemoryPlan> {
  const res = await tx.execute<PlanRow>(sql`
    SELECT t.is_test, t.skill_eval, COALESCE(
      CASE
        WHEN t.agent_id IS NULL THEN 'all'
        WHEN t.agent_scope = 'team' THEN (
          SELECT v.memory FROM team_agent_versions v
           WHERE v.team_id = r.team_id AND v.agent_id = t.agent_id
             AND v.version = COALESCE(r.agent_version, t.agent_version, (
               SELECT a.current_version FROM team_agents a
                WHERE a.team_id = r.team_id AND a.id = t.agent_id)))
        ELSE (
          SELECT v.memory FROM site_agent_versions v
           WHERE v.agent_id = t.agent_id
             AND v.version = COALESCE(r.agent_version, t.agent_version, (
               SELECT a.current_version FROM site_agents a WHERE a.id = t.agent_id)))
      END, 'all') AS memory
      FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${run.teamId} AND r.id = ${run.runId}`);
  const row = res.rows[0];
  if (!row) throw new Error("the run was not found");
  const setting = agentMemorySettingSchema.parse(row.memory);
  return memoryPlan(setting, row.skill_eval ? "skill_eval" : row.is_test ? "test_chat" : "none");
}
