import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { KobeDb } from "../client.js";
import { agentEvalCases, orbitEvals } from "../schema/index.js";
import { withTeam } from "../with-team.js";

/**
 * The shared eval cases an Orbit eval Job runs (KOBE-276), as the eval image's `cases.json`. Case
 * text never sits in a Kubernetes object (review S2): the Job asks the model gateway for it with
 * its own eval token, and the gateway reads it here, under the team's RLS, only while that eval
 * is running for the member who started it, and only once. Only the cases frozen into the eval
 * that are still accepted come back, so a withdrawal or a dismissal takes effect at once (the eval then errors:
 * its result can't cover a case it never got, and the publisher retries).
 */

/** `images/orbit-eval/kobe_orbit_eval/cases.py` SUITE_ID and SCHEMA_VERSION. */
export const EVAL_CASE_SUITE = { id: "shared-cases", schemaVersion: 1 } as const;

export interface EvalCaseFileEntry {
  readonly id: string;
  readonly content: Record<string, unknown>;
  readonly expected: string;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The `cases.json` text for `cases` (null: none). */
export function evalCasesFile(cases: readonly EvalCaseFileEntry[]): string | null {
  if (cases.length === 0) return null;
  return `${JSON.stringify({
    schema_version: EVAL_CASE_SUITE.schemaVersion,
    suite: EVAL_CASE_SUITE.id,
    cases: cases.map((c) => ({
      id: c.id,
      prompt: c.content.prompt,
      earlier: list(c.content.earlier),
      tool_outputs: list(c.content.tool_outputs),
      attachments: list(c.content.attachments),
      rated_answer: c.content.answer,
      reasons: list(c.content.reasons),
      comment: c.content.comment ?? null,
      expected: c.expected,
    })),
  })}\n`;
}

/**
 * `cases.json` for eval `evalId` of `userId` in `teamId`, once (re-review R2): the first fetch
 * stamps `cases_fetched_at`, and any later one, or one for an eval not running for them, gets
 * null. Only cases frozen into the eval, of its agent, still accepted, not hidden for a hold, and
 * shared during their sharer's current active membership are served (defence in depth: the gate
 * froze only live ones; the retention window is not re-applied within an eval's few minutes).
 */
export function loadEvalCaseFile(
  db: KobeDb,
  teamId: string,
  userId: string,
  evalId: string,
): Promise<string | null> {
  return withTeam(db, teamId, async (tx) => {
    const [run] = await tx
      .update(orbitEvals)
      .set({ casesFetchedAt: sql`now()` })
      .where(
        and(
          eq(orbitEvals.teamId, teamId),
          eq(orbitEvals.id, evalId),
          eq(orbitEvals.requestedBy, userId),
          eq(orbitEvals.status, "running"),
          isNull(orbitEvals.casesFetchedAt),
          sql`cardinality(${orbitEvals.caseIds}) > 0`,
        ),
      )
      .returning({
        caseIds: orbitEvals.caseIds,
        agentId: orbitEvals.agentId,
        agentScope: orbitEvals.agentScope,
      });
    if (!run || run.agentScope === "gallery") return null;
    const rows = await tx
      .select({
        id: agentEvalCases.id,
        content: agentEvalCases.content,
        expected: agentEvalCases.expectedBehaviour,
      })
      .from(agentEvalCases)
      .where(
        and(
          eq(agentEvalCases.teamId, teamId),
          inArray(agentEvalCases.id, [...run.caseIds]),
          eq(agentEvalCases.agentId, run.agentId),
          eq(agentEvalCases.agentScope, run.agentScope),
          eq(agentEvalCases.status, "accepted"),
          isNull(agentEvalCases.hiddenAt),
          sql`${agentEvalCases.expectedBehaviour} IS NOT NULL`,
          sql`EXISTS (SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
                WHERE m.team_id = ${agentEvalCases.teamId} AND m.user_id = ${agentEvalCases.userId}
                  AND u.deactivated_at IS NULL AND m.created_at <= ${agentEvalCases.createdAt})`,
        ),
      );
    const order = new Map(run.caseIds.map((id, i) => [id, i]));
    const sorted = [...rows].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return evalCasesFile(sorted.map((r) => ({ ...r, expected: r.expected ?? "" })));
  });
}
