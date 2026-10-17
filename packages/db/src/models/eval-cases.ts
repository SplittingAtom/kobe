import { and, eq, inArray, sql } from "drizzle-orm";
import type { KobeDb } from "../client.js";
import { agentEvalCases, orbitEvals } from "../schema/index.js";
import { withTeam } from "../with-team.js";

/**
 * The shared eval cases an Orbit eval Job runs (KOBE-276), as the eval image's `cases.json`. Case
 * text never sits in a Kubernetes object (review S2): the Job asks the model gateway for it with
 * its own eval token, and the gateway reads it here, under the team's RLS, only while that eval
 * is running for the member who started it. Only the cases frozen into the eval that are still
 * accepted come back, so a withdrawal or a dismissal takes effect at once (the eval then errors:
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
 * `cases.json` for eval `evalId` of `userId` in `teamId`, or null when that eval is not running
 * for them or has no cases left.
 */
export function loadEvalCaseFile(
  db: KobeDb,
  teamId: string,
  userId: string,
  evalId: string,
): Promise<string | null> {
  return withTeam(db, teamId, async (tx) => {
    const [run] = await tx
      .select({ caseIds: orbitEvals.caseIds })
      .from(orbitEvals)
      .where(
        and(
          eq(orbitEvals.teamId, teamId),
          eq(orbitEvals.id, evalId),
          eq(orbitEvals.requestedBy, userId),
          eq(orbitEvals.status, "running"),
        ),
      );
    if (!run || run.caseIds.length === 0) return null;
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
          eq(agentEvalCases.status, "accepted"),
          sql`${agentEvalCases.expectedBehaviour} IS NOT NULL`,
        ),
      );
    const order = new Map(run.caseIds.map((id, i) => [id, i]));
    const sorted = [...rows].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return evalCasesFile(sorted.map((r) => ({ ...r, expected: r.expected ?? "" })));
  });
}
