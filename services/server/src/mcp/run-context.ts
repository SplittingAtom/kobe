import { APPROVAL_MODES, type ApprovalMode } from "@kobe/protocol";
import { sql, withTeam, type KobeDb } from "@kobe/db";
import { clampApprovalMode } from "../sandbox-wire/policy-check.js";
import type { RunPolicyContextSource } from "../sandbox-wire/types.js";
import type { McpPrincipal } from "./decide.js";

/**
 * The runs an MCP call might belong to (KOBE-58 review M1). Pi's MCP client cannot say which tool
 * call (or run) a `tools/call` comes from, and the `Kobe-Thread-Id` header is the sandbox's claim:
 * a prompt-injected thread could name a sibling thread whose run has a laxer policy (a scheduled
 * run in `auto`, a broader agent allow list). So the server loads **every** active run of the
 * token's user that is leased to the token's sandbox, each with its own policy context exactly as
 * the wire's `policy.check` builds it, and the caller evaluates the call under all of them.
 */

/** Active runs one sandbox may hold at once; beyond it the call is denied (fail closed). */
export const MAX_ACTIVE_RUNS_PER_SANDBOX = 32;

export interface ActiveRunContext {
  readonly runId: string;
  readonly threadId: string;
  readonly trigger: "user" | "schedule";
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly mode: ApprovalMode;
  readonly toolsAllow: string[];
  readonly toolsDeny: string[];
  readonly projectId?: string;
}

export type ActiveRuns =
  | { readonly ok: true; readonly runs: readonly ActiveRunContext[] }
  | { readonly ok: false; readonly reason: "too_many_runs" };

export async function loadActiveRuns(
  db: KobeDb,
  runContext: RunPolicyContextSource,
  principal: McpPrincipal,
): Promise<ActiveRuns> {
  return withTeam(db, principal.teamId, async (tx) => {
    const res = await tx.execute<{
      run_id: string;
      thread_id: string;
      trigger: "user" | "schedule";
      agent_id: string | null;
      agent_version: number | null;
      project_id: string | null;
    }>(sql`
      SELECT r.id AS run_id, t.id AS thread_id, r.trigger, t.agent_id, t.agent_version, t.project_id
        FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
        JOIN sandbox_run_leases l ON l.team_id = r.team_id AND l.run_id = r.id
       WHERE r.team_id = ${principal.teamId} AND t.team_id = ${principal.teamId}
         AND r.status IN ('running', 'waiting_approval')
         AND t.owner_user_id = ${principal.userId}
         AND l.user_id = ${principal.userId} AND l.sandbox_id = ${principal.sandboxId}
       ORDER BY r.created_at DESC, r.id
       LIMIT ${MAX_ACTIVE_RUNS_PER_SANDBOX + 1}`);
    if (res.rows.length > MAX_ACTIVE_RUNS_PER_SANDBOX)
      return { ok: false, reason: "too_many_runs" };
    const runs: ActiveRunContext[] = [];
    for (const row of res.rows) {
      const context = await runContext.load(tx, {
        teamId: principal.teamId,
        runId: row.run_id,
        threadId: row.thread_id,
      });
      if (!APPROVAL_MODES.includes(context.floor)) throw new Error("approval floor unavailable");
      // As the wire's policy.check: scheduled runs are auto (D32), everything clamped to the floor.
      const requested =
        row.trigger === "schedule" ? "auto" : (context.approvalMode ?? "ask-on-write");
      const projectId = context.projectId ?? row.project_id ?? undefined;
      runs.push({
        runId: row.run_id,
        threadId: row.thread_id,
        trigger: row.trigger,
        agentId: row.agent_id,
        agentVersion: row.agent_version,
        mode: clampApprovalMode(
          APPROVAL_MODES.includes(requested) ? requested : "ask-on-write",
          context.floor,
        ),
        toolsAllow: [...(context.toolsAllow ?? [])],
        toolsDeny: [...(context.toolsDeny ?? [])],
        ...(projectId === undefined ? {} : { projectId }),
      });
    }
    return { ok: true, runs };
  });
}
