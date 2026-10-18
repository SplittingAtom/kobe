import {
  EVAL_CASE_EXCERPT_CHARS,
  EVAL_CASE_MAX_ACCEPTED,
  type AgentEvalCase,
  type AgentEvalCaseSummary,
  type AgentEvalCases,
  type EvalCaseContent,
  type EvalCaseErrorCode,
  type FeedbackReason,
  type ReviewEvalCaseBody,
} from "@kobe/protocol";
import {
  agentEvalCases,
  and,
  asc,
  eq,
  isNull,
  sql,
  teamMembers,
  users,
  type KobeTx,
} from "@kobe/db";
import { teamRoleAllows } from "../authz/permissions.js";
import { recordAudit } from "../audit/record.js";
import { cutText } from "../threads/entry-output.js";
import { caseCutoff, liveCase, sharedOnFinishedDay } from "./visibility.js";

/**
 * The agent owner's side of shared eval cases (KOBE-276): list, read and review the cases shared
 * on one agent in the active team. The caller has checked that the viewer owns the agent; every
 * query is keyed on (team, agent). Nothing here selects `user_id`: the sharer is never shown, and
 * the list gives the day a case was shared, not the time.
 */

export type ReviewError = Extract<
  EvalCaseErrorCode,
  "case_not_found" | "expected_behaviour_required" | "case_limit"
>;

export type ReviewResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ReviewError };

export interface AgentKey {
  readonly teamId: string;
  readonly agentId: string;
  readonly scope: "team" | "personal";
}

const columns = {
  id: agentEvalCases.id,
  status: agentEvalCases.status,
  agentVersion: agentEvalCases.agentVersion,
  content: agentEvalCases.content,
  expectedBehaviour: agentEvalCases.expectedBehaviour,
  reviewedAt: agentEvalCases.reviewedAt,
  sharedOn: sql<string>`to_char(${agentEvalCases.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
};

type Row = {
  readonly id: string;
  readonly status: AgentEvalCaseSummary["status"];
  readonly agentVersion: number | null;
  readonly content: Record<string, unknown>;
  readonly expectedBehaviour: string | null;
  readonly reviewedAt: Date | null;
  readonly sharedOn: string;
};

const contentOf = (row: Row) => row.content as unknown as EvalCaseContent;

function toSummary(row: Row): AgentEvalCaseSummary {
  const content = contentOf(row);
  return {
    id: row.id,
    status: row.status,
    agent_version: row.agentVersion,
    reasons: [...(content.reasons ?? [])] as FeedbackReason[],
    prompt_excerpt: cutText(content.prompt ?? "", EVAL_CASE_EXCERPT_CHARS),
    shared_on: row.sharedOn,
    expected_behaviour: row.expectedBehaviour,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
  };
}

const toCase = (row: Row): AgentEvalCase => ({ ...toSummary(row), content: contentOf(row) });

const ofAgent = (key: AgentKey) =>
  and(
    eq(agentEvalCases.teamId, key.teamId),
    eq(agentEvalCases.agentId, key.agentId),
    eq(agentEvalCases.agentScope, key.scope),
  );

/**
 * The agent's cases its owner may see (visibility.ts): live (within the window, sharer still a
 * member: a case a hold keeps looks purged) and shared on a UTC day that has ended.
 */
async function ownerView(tx: KobeTx, key: AgentKey) {
  return and(ofAgent(key), liveCase(await caseCutoff(tx, key.teamId)), sharedOnFinishedDay);
}

/**
 * Most cases one list answers: open first, then accepted, then dismissed; newest day first, and
 * within a day by id (random), so the order never tells the order of shares (review S5).
 */
const LIST_LIMIT = 500;

export async function listAgentCases(tx: KobeTx, key: AgentKey): Promise<AgentEvalCases> {
  const rows = await tx
    .select(columns)
    .from(agentEvalCases)
    .where(await ownerView(tx, key))
    .orderBy(
      sql`CASE ${agentEvalCases.status} WHEN 'open' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END`,
      sql`date_trunc('day', ${agentEvalCases.createdAt} AT TIME ZONE 'UTC') DESC`,
      asc(agentEvalCases.id),
    )
    .limit(LIST_LIMIT);
  return {
    agent_id: key.agentId,
    accepted: await acceptedCount(tx, key),
    max_accepted: EVAL_CASE_MAX_ACCEPTED,
    cases: rows.map(toSummary),
  };
}

async function acceptedCount(tx: KobeTx, key: AgentKey): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(agentEvalCases)
    .where(and(await ownerView(tx, key), eq(agentEvalCases.status, "accepted")));
  return row?.n ?? 0;
}

export async function getAgentCase(
  tx: KobeTx,
  key: AgentKey,
  caseId: string,
): Promise<AgentEvalCase | null> {
  const [row] = await tx
    .select(columns)
    .from(agentEvalCases)
    .where(and(await ownerView(tx, key), eq(agentEvalCases.id, caseId)));
  return row ? toCase(row) : null;
}

/**
 * Accepts, dismisses or reopens a case, or edits its expected behaviour. Accepting needs an
 * expected behaviour and room under {@link EVAL_CASE_MAX_ACCEPTED} (checked under a per-agent
 * lock, so two owners' accepts can't both take the last place). A status change is audited
 * (ids and status only).
 */
export async function reviewAgentCase(
  tx: KobeTx,
  key: AgentKey,
  caseId: string,
  body: ReviewEvalCaseBody,
  actor: { readonly userId: string },
): Promise<ReviewResult<AgentEvalCase>> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.eval_cases:${key.teamId}:${key.agentId}`}, 0))`,
  );
  const [current] = await tx
    .select({ status: agentEvalCases.status, expected: agentEvalCases.expectedBehaviour })
    .from(agentEvalCases)
    .where(and(await ownerView(tx, key), eq(agentEvalCases.id, caseId)))
    .for("update");
  if (!current) return { ok: false, error: "case_not_found" };
  const status = body.status ?? current.status;
  const expected =
    body.expected_behaviour === undefined ? current.expected : body.expected_behaviour;
  if (status === "accepted" && expected === null) {
    return { ok: false, error: "expected_behaviour_required" };
  }
  if (
    status === "accepted" &&
    current.status !== "accepted" &&
    (await acceptedCount(tx, key)) >= EVAL_CASE_MAX_ACCEPTED
  ) {
    return { ok: false, error: "case_limit" };
  }
  const changed = status !== current.status || expected !== current.expected;
  const [row] = await tx
    .update(agentEvalCases)
    .set({
      status,
      expectedBehaviour: expected,
      ...(changed ? { reviewedAt: sql`now()` } : {}),
    })
    .where(and(ofAgent(key), eq(agentEvalCases.id, caseId)))
    .returning(columns);
  if (!row) return { ok: false, error: "case_not_found" };
  if (status !== current.status) {
    await recordAudit(tx, {
      action: "agent.eval_case.reviewed",
      actor: { kind: "user", id: actor.userId },
      teamId: key.teamId,
      target: { agentId: key.agentId, scope: key.scope, caseId, status },
    });
  }
  return { ok: true, value: toCase(row) };
}

/**
 * The agent's accepted cases (live ones only: a case a hold keeps past its window never runs),
 * what its next gated publish runs (KOBE-93).
 */
export async function acceptedCases(
  tx: KobeTx,
  key: AgentKey,
): Promise<{ id: string; content: EvalCaseContent; expected: string }[]> {
  const rows = await tx
    .select({
      id: agentEvalCases.id,
      content: agentEvalCases.content,
      expected: agentEvalCases.expectedBehaviour,
    })
    .from(agentEvalCases)
    .where(and(await ownerView(tx, key), eq(agentEvalCases.status, "accepted")))
    .orderBy(asc(agentEvalCases.id))
    .limit(EVAL_CASE_MAX_ACCEPTED);
  return rows.map((r) => ({
    id: r.id,
    content: r.content as unknown as EvalCaseContent,
    expected: r.expected ?? "",
  }));
}

/**
 * Whether anyone can review the agent's cases (review S1): a personal agent's owner is the
 * publisher; a team agent's owner must still be an active member who may build. Team admins
 * can't read cases, so without such an owner the gate leaves them out.
 */
export async function caseReviewerPresent(
  tx: KobeTx,
  teamId: string,
  agent: { readonly scope: string; readonly ownerUserId: string | null },
): Promise<boolean> {
  if (agent.scope === "personal") return true;
  if (agent.scope !== "team" || agent.ownerUserId === null) return false;
  const [member] = await tx
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, agent.ownerUserId),
        isNull(users.deactivatedAt),
      ),
    );
  return member !== undefined && teamRoleAllows(member.role, "team.agents.build");
}
