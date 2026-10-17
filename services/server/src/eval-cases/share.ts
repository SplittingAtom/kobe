import type {
  EvalCaseContent,
  EvalCaseErrorCode,
  EvalCaseOptions,
  EvalCasePreview,
  FeedbackReason,
  MyEvalCase,
  ShareEvalCaseBody,
} from "@kobe/protocol";
import { agentEvalCases, and, answerFeedback, desc, eq, runs, sql, type KobeTx } from "@kobe/db";
import { findThread, type Viewer } from "../threads/repository.js";
import { buildCopy, type BuiltCopy, type ExchangeSource } from "./copy.js";
import { caseCutoff, liveCase } from "./visibility.js";

/**
 * Sharing an answer as an eval case (KOBE-276), on the member's side. Runs inside the caller's
 * `withTeam` transaction and repeats `team_id` in every predicate. Who may share: the owner of
 * the conversation (their own words), from their own thumbs down, on a team or personal agent.
 * The share needs the preview's digest; withdrawal deletes the member's own case only.
 */

export type ShareError = Extract<
  EvalCaseErrorCode,
  | "invalid_request"
  | "run_not_found"
  | "not_shareable"
  | "thread_unavailable"
  | "exchange_unavailable"
  | "already_shared"
  | "preview_stale"
>;

export type ShareResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ShareError };

const fail = (error: ShareError): { ok: false; error: ShareError } => ({ ok: false, error });

interface Shareable {
  readonly source: ExchangeSource;
  readonly feedbackId: string;
  readonly agent: EvalCasePreview["agent"];
  readonly sharedCaseId: string | null;
  /** This rating's case that only a hold keeps (past the window): replaced by a new share. */
  readonly staleCaseId: string | null;
}

/** The viewer's thumbs down on their own conversation's ended answer `runId`, or why not. */
async function shareable(
  tx: KobeTx,
  viewer: Viewer,
  runId: string,
): Promise<ShareResult<Shareable>> {
  const [run] = await tx
    .select({
      threadId: runs.threadId,
      kind: runs.kind,
      endedAt: runs.endedAt,
      input: runs.input,
      userEntryId: runs.userEntryId,
    })
    .from(runs)
    .where(and(eq(runs.teamId, viewer.teamId), eq(runs.id, runId)));
  if (!run) return fail("run_not_found");
  // Unknown run, another team's, or a thread the viewer can't read: the same 404.
  const found = await findThread(tx, viewer, run.threadId);
  if (!found) return fail("run_not_found");
  if (found.thread.isTest || found.thread.deletedAt !== null) return fail("thread_unavailable");
  if (found.access !== "owner" || run.kind !== "message" || run.endedAt === null) {
    return fail("not_shareable");
  }
  const [rating] = await tx
    .select({
      id: answerFeedback.id,
      rating: answerFeedback.rating,
      reasons: answerFeedback.reasons,
      comment: answerFeedback.comment,
      agentScope: answerFeedback.agentScope,
      agentId: answerFeedback.agentId,
      agentVersion: answerFeedback.agentVersion,
    })
    .from(answerFeedback)
    .where(
      and(
        eq(answerFeedback.teamId, viewer.teamId),
        eq(answerFeedback.runId, runId),
        eq(answerFeedback.userId, viewer.userId),
      ),
    );
  if (
    !rating ||
    rating.rating !== "down" ||
    rating.agentId === null ||
    (rating.agentScope !== "team" && rating.agentScope !== "personal")
  ) {
    return fail("not_shareable");
  }
  if (run.userEntryId === null || run.input.trim() === "") return fail("exchange_unavailable");
  const [shared] = await tx
    .select({
      id: agentEvalCases.id,
      live: sql<boolean>`${liveCase(await caseCutoff(tx, viewer.teamId))}`,
    })
    .from(agentEvalCases)
    .where(and(eq(agentEvalCases.teamId, viewer.teamId), eq(agentEvalCases.feedbackId, rating.id)));
  return {
    ok: true,
    value: {
      source: {
        teamId: viewer.teamId,
        threadId: run.threadId,
        runId,
        input: run.input,
        userEntryId: run.userEntryId,
        reasons: rating.reasons as FeedbackReason[],
        comment: rating.comment,
      },
      feedbackId: rating.id,
      agent: { scope: rating.agentScope, id: rating.agentId, version: rating.agentVersion },
      // A case past its window (kept only by a hold) counts as purged (review S3).
      sharedCaseId: shared?.live ? shared.id : null,
      staleCaseId: shared && !shared.live ? shared.id : null,
    },
  };
}

async function copyFor(
  tx: KobeTx,
  viewer: Viewer,
  runId: string,
  options: EvalCaseOptions,
): Promise<ShareResult<{ found: Shareable; copy: Extract<BuiltCopy, { ok: true }> }>> {
  const found = await shareable(tx, viewer, runId);
  if (!found.ok) return found;
  const copy = await buildCopy(tx, found.value.source, options);
  if (!copy.ok) return fail(copy.error);
  return { ok: true, value: { found: found.value, copy } };
}

/** What sharing `runId`'s answer with `options` would store: the preview, with its digest. */
export async function previewCase(
  tx: KobeTx,
  viewer: Viewer,
  runId: string,
  options: EvalCaseOptions,
): Promise<ShareResult<EvalCasePreview>> {
  const built = await copyFor(tx, viewer, runId, options);
  if (!built.ok) return built;
  const { found, copy } = built.value;
  return {
    ok: true,
    value: {
      run_id: runId,
      agent: found.agent,
      content: copy.content,
      digest: copy.digest,
      available: copy.available,
      shared_case_id: found.sharedCaseId,
    },
  };
}

const myColumns = {
  id: agentEvalCases.id,
  agentScope: agentEvalCases.agentScope,
  agentId: agentEvalCases.agentId,
  agentVersion: agentEvalCases.agentVersion,
  status: agentEvalCases.status,
  content: agentEvalCases.content,
  createdAt: agentEvalCases.createdAt,
};

type MyRow = {
  readonly id: string;
  readonly agentScope: string;
  readonly agentId: string;
  readonly agentVersion: number | null;
  readonly status: MyEvalCase["status"];
  readonly content: Record<string, unknown>;
  readonly createdAt: Date;
};

function toMyCase(row: MyRow): MyEvalCase {
  return {
    id: row.id,
    agent: {
      scope: row.agentScope === "personal" ? "personal" : "team",
      id: row.agentId,
      version: row.agentVersion,
    },
    status: row.status,
    content: row.content as unknown as EvalCaseContent,
    shared_at: row.createdAt.toISOString(),
  };
}

/**
 * Shares the answer as previewed: the copy is rebuilt with the same options and must have the
 * preview's digest (else `preview_stale`), so only what the member saw is stored.
 */
export async function shareCase(
  tx: KobeTx,
  viewer: Viewer,
  runId: string,
  body: ShareEvalCaseBody,
): Promise<ShareResult<MyEvalCase>> {
  const { digest, ...options } = body;
  const built = await copyFor(tx, viewer, runId, options);
  if (!built.ok) return built;
  const { found, copy } = built.value;
  if (found.sharedCaseId !== null) return fail("already_shared");
  if (copy.digest !== digest) return fail("preview_stale");
  if (found.staleCaseId !== null) {
    // As if purged: it goes (a hold keeps its copy aside) and the new share takes the key.
    await tx
      .delete(agentEvalCases)
      .where(
        and(eq(agentEvalCases.teamId, viewer.teamId), eq(agentEvalCases.id, found.staleCaseId)),
      );
  }
  const [row] = await tx
    .insert(agentEvalCases)
    .values({
      teamId: viewer.teamId,
      feedbackId: found.feedbackId,
      userId: viewer.userId,
      agentScope: found.agent.scope,
      agentId: found.agent.id,
      agentVersion: found.agent.version,
      content: copy.content as unknown as Record<string, unknown>,
    })
    // Shared twice at once: the second finds the one-case-per-rating key taken.
    .onConflictDoNothing({ target: [agentEvalCases.teamId, agentEvalCases.feedbackId] })
    .returning(myColumns);
  if (!row) return fail("already_shared");
  return { ok: true, value: toMyCase(row) };
}

/**
 * The viewer's own live cases in the team, newest first, whether or not their rating still exists:
 * the way to withdraw one after clearing the rating (review S6). A case past the window that only a
 * hold keeps is not listed (as if purged).
 */
export async function myCases(tx: KobeTx, viewer: Viewer): Promise<MyEvalCase[]> {
  const rows = await tx
    .select(myColumns)
    .from(agentEvalCases)
    .where(
      and(
        eq(agentEvalCases.teamId, viewer.teamId),
        eq(agentEvalCases.userId, viewer.userId),
        liveCase(await caseCutoff(tx, viewer.teamId)),
      ),
    )
    .orderBy(desc(agentEvalCases.createdAt), desc(agentEvalCases.id))
    .limit(500);
  return rows.map(toMyCase);
}

/**
 * Withdraws the viewer's case: their own row only, whatever its status. Under a legal hold the
 * database keeps a copy aside (`*_agent_eval_cases_rls.sql`) and this answers the same.
 */
export async function withdrawCase(tx: KobeTx, viewer: Viewer, caseId: string): Promise<void> {
  await tx
    .delete(agentEvalCases)
    .where(
      and(
        eq(agentEvalCases.teamId, viewer.teamId),
        eq(agentEvalCases.id, caseId),
        eq(agentEvalCases.userId, viewer.userId),
      ),
    );
}
