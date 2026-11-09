import {
  APPROVAL_TTL_MS,
  type PolicyDecision,
  type ProjectCommitFrame,
  type ProjectCommitOutcome,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import { sql, withTeam } from "@kobe/db";
import type { Logger } from "pino";
import type { AllowedVerdict } from "../artifacts/allowed.js";
import { approvalHolds, noPromptCode, recordDeniedWrite } from "../approvals/server-write.js";
import type { ApprovalVerifier } from "../approvals/verify.js";
import { loadAccess } from "../projects/access.js";
import {
  commitWorkingCopy,
  previewCommit,
  type CommitDeps,
  type CommitResult,
} from "../projects/commits.js";
import type { ApprovalBroker, SandboxTarget } from "./types.js";

/**
 * `project.commit` (KOBE-579, Workspaces CM6) on one connection: the agent's `commit_project`.
 * The sandbox pushed its working copy first; nothing it says about the files is trusted. Accepted
 * only if the connection announced `projects`, the run is leased here and active, and the policy
 * check allowed this exact call (input hash, D-3). Then, from the database: the run is the
 * caller's and active, its thread is in a project, the run's owner may edit it (PR3), and the run
 * may wait for a person (D32: `auto` and scheduled runs are refused and the skip is recorded).
 *
 * The approval binds what is committed: the server builds the canonical input itself, `{project_id,
 * base_seq, message, diff_sha256}` (the SHA-256 of the sorted diff of the working copy against the
 * checkout's base, `projects/tree.ts diffHash`). When a policy rule allowed the call outright the
 * commit runs at once; otherwise the policy check deferred the approval to here
 * (`SERVER_APPROVED_TOOLS`), an approval over that input is asked, the sandbox is answered
 * `pending_approval`, and the commit runs when it is granted, only if the working copy still has
 * the same base and diff hash. One commit per project and connection is in flight at a time: a
 * repeat meanwhile is answered `pending_approval` without asking again. Exactly one
 * `project.commit_result` per frame.
 */
export interface ProjectCommitDeps {
  readonly commit: CommitDeps;
  readonly approvals: ApprovalBroker;
  readonly verifier: ApprovalVerifier | undefined;
  readonly runMaxEvents: number;
  readonly log: Pick<Logger, "warn" | "error">;
}

export interface ProjectCommitConnection {
  readonly deps: ProjectCommitDeps;
  readonly target: SandboxTarget;
  readonly connectionId: string;
  readonly hasCapability: boolean;
  /** `#checkToolRun` for this frame; "violation" was already answered and the frame dropped. */
  readonly runCheck: () => "ok" | "ended" | "violation";
  /** The policy check's allowance for this call (same tool and input hash). */
  readonly verdict: () => AllowedVerdict;
  /**
   * True only when the policy check allowed the call by a rule (a positive mark on the allowance);
   * anything else, including an evicted entry, asks for an approval (fail closed).
   */
  readonly ruleAllowed: () => boolean;
  /** Projects with a commit waiting for approval on this connection. */
  readonly pending: Set<string>;
  /** Aborts when the connection closes (a pending approval resolves as denied). */
  readonly signal: AbortSignal;
  send(frame: ServerToSandboxFrame): boolean;
}

const TOOL = "commit_project";

type Reply =
  { ok: true; outcome: ProjectCommitOutcome } | { ok: false; code: string; message: string };

const failed = (code: string, message: string): Reply => ({ ok: false, code, message });

/** A commit outcome as the tool sees it (the message reaches the model verbatim). */
export function replyOf(result: CommitResult): Reply {
  switch (result.status) {
    case "committed":
      return { ok: true, outcome: { status: "committed", seq: result.seq } };
    case "nothing_to_commit":
      return { ok: true, outcome: { status: "nothing_to_commit" } };
    case "commit_conflict":
      return { ok: true, outcome: { status: "commit_conflict", head_seq: result.headSeq } };
    case "refused":
      break;
  }
  const named = result.path === undefined ? "" : ` (${result.path})`;
  switch (result.error) {
    case "not_found":
    case "forbidden":
      return failed("not_allowed", "You can read this project but not change it.");
    case "checkout_required":
      return failed(
        "checkout_required",
        "The project is not checked out. Ask the user to check it out, then commit.",
      );
    case "archived":
      return failed("not_allowed", "The project is archived.");
    case "too_many_files":
      return failed("too_many_files", "A project holds at most 500 files.");
    case "file_too_large":
      return failed("too_large", `A file is larger than a project file may be${named}.`);
    case "conflict_file":
      return failed(
        "conflict_file",
        `A conflict copy is in the working copy${named}: resolve it (keep what is needed, delete the copy), then commit.`,
      );
    case "invalid_path":
      return failed("invalid_path", `A file name can't be used in a project${named}.`);
    case "quota_exceeded":
      return failed(
        "quota_exceeded",
        result.limit === "objects"
          ? "The commit would pass the workspace's object budget."
          : "The commit would pass the workspace's storage quota.",
      );
    case "legal_hold":
      return failed(
        "not_allowed",
        "The workspace is under a legal hold; its files stay as they are.",
      );
    case "changed":
      return failed(
        "not_allowed",
        "The working copy changed after the commit was approved, so nothing was committed.",
      );
    case "storage_failed":
      return failed("storage_failed", "The commit could not be stored. Try again.");
  }
}

const approvalDecision = (): Extract<PolicyDecision, { effect: "require_approval" }> => ({
  effect: "require_approval",
  // The broker sets the real expiry (1 h, D29).
  expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  risk: "write",
  reasons: [
    {
      code: "risk_write",
      stage: "risk_class",
      message: "commit_project writes a new version of the project's shared files.",
    },
  ],
});

type Gate =
  { readonly ok: true; readonly projectId: string } | { readonly ok: false; readonly reply: Reply };

/** The run is the caller's, active and a message run; its project; edit access (PR3). */
async function gate(c: ProjectCommitConnection, frame: ProjectCommitFrame): Promise<Gate> {
  const { teamId, userId } = c.target;
  return withTeam(c.deps.commit.db, teamId, async (tx) => {
    const res = await tx.execute<{ status: string; kind: string; project_id: string | null }>(sql`
      SELECT r.status, r.kind, t.project_id FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${teamId} AND r.id = ${frame.run_id} AND r.thread_id = ${frame.thread_id}
         AND t.team_id = ${teamId} AND t.owner_user_id = ${userId}`);
    const row = res.rows[0];
    if (
      (row?.status !== "running" && row?.status !== "waiting_approval") ||
      row.kind !== "message"
    ) {
      return {
        ok: false,
        reply: failed("not_allowed", "The run has ended, so nothing was committed."),
      };
    }
    if (row.project_id === null) {
      return {
        ok: false,
        reply: failed("not_in_project", "This conversation is not in a project."),
      };
    }
    const access = await loadAccess(tx, { teamId, userId }, row.project_id);
    if (!access?.can.edit) {
      return {
        ok: false,
        reply: failed("not_allowed", "You can read this project but not change it."),
      };
    }
    return { ok: true, projectId: row.project_id };
  });
}

export function onProjectCommit(
  c: ProjectCommitConnection,
  frame: ProjectCommitFrame,
): Promise<void> {
  let answered = false;
  const answer = (reply: Reply): void => {
    if (answered) return;
    answered = true;
    c.send(
      reply.ok
        ? {
            v: 1,
            type: "project.commit_result",
            request_id: frame.request_id,
            ok: true,
            op: "project_commit",
            outcome: reply.outcome,
          }
        : {
            v: 1,
            type: "project.commit_result",
            request_id: frame.request_id,
            ok: false,
            error: { code: reply.code, message: reply.message.slice(0, 2000) },
          },
    );
  };
  if (!c.hasCapability) {
    answer(failed("not_allowed", "This sandbox did not announce projects."));
    return Promise.resolve();
  }
  const check = c.runCheck();
  if (check === "violation") return Promise.resolve();
  if (check === "ended") {
    answer(failed("not_allowed", "The run has ended, so nothing was committed."));
    return Promise.resolve();
  }
  const verdict = c.verdict();
  if (verdict !== "ok") {
    c.deps.log.warn({ run_id: frame.run_id, verdict, security: true }, "project.commit refused");
    answer(
      failed(
        "not_allowed",
        verdict === "input_mismatch"
          ? "The commit differs from the call that was allowed."
          : "This tool call was not allowed for this tool.",
      ),
    );
    return Promise.resolve();
  }
  let held: string | undefined;
  return run(c, frame, answer, (projectId) => {
    held = projectId;
  })
    .catch((err: unknown) => {
      c.deps.log.error({ err, run_id: frame.run_id }, "project.commit failed");
      answer(failed("storage_failed", "The commit could not be stored. Try again."));
    })
    .finally(() => {
      if (held !== undefined) c.pending.delete(held);
    });
}

async function run(
  c: ProjectCommitConnection,
  frame: ProjectCommitFrame,
  answer: (reply: Reply) => void,
  hold: (projectId: string) => void,
): Promise<void> {
  const { deps } = c;
  const call = {
    teamId: c.target.teamId,
    userId: c.target.userId,
    runId: frame.run_id,
    toolCallId: frame.tool_call_id,
  };
  const g = await gate(c, frame);
  if (!g.ok) {
    answer(g.reply);
    return;
  }
  // D32: a run that never waits for a person never commits; the skip is recorded.
  const noPrompt = await noPromptCode(deps.commit.db, call);
  if (noPrompt) {
    await recordDeniedWrite(deps.commit.db, deps.log, call, TOOL, deps.runMaxEvents, noPrompt);
    answer(
      failed("not_allowed", "This run does not wait for approvals, so nothing was committed."),
    );
    return;
  }
  // Checked and taken in one synchronous step: a repeat can never slip in between.
  if (c.pending.has(g.projectId)) {
    answer({ ok: true, outcome: { status: "pending_approval" } });
    return;
  }
  c.pending.add(g.projectId);
  hold(g.projectId);
  const owner = { teamId: c.target.teamId, userId: c.target.userId };
  const preview = await previewCommit(deps.commit, { owner, projectId: g.projectId });
  if ("status" in preview) {
    answer(replyOf(preview));
    return;
  }
  const input = {
    project_id: g.projectId,
    base_seq: preview.baseSeq,
    message: frame.input.message,
    diff_sha256: preview.diffHash,
  };
  const commit = () =>
    commitWorkingCopy(deps.commit, {
      owner,
      projectId: g.projectId,
      message: frame.input.message,
      author: {
        userId: owner.userId,
        kind: "agent",
        threadId: frame.thread_id,
        runId: frame.run_id,
      },
      expect: { baseSeq: preview.baseSeq, diffHash: preview.diffHash },
    });
  if (c.ruleAllowed()) {
    // A policy rule allowed commit_project outright (remembered or team rule): no approval.
    answer(replyOf(await commit()));
    return;
  }
  const outcome = await deps.approvals.request(
    {
      teamId: owner.teamId,
      userId: owner.userId,
      connectionId: c.connectionId,
      runId: frame.run_id,
      threadId: frame.thread_id,
      toolCallId: frame.tool_call_id,
      tool: TOOL,
      input,
      decision: approvalDecision(),
      signal: c.signal,
    },
    () => answer({ ok: true, outcome: { status: "pending_approval" } }),
  );
  if (outcome.decision === "deny") {
    answer(failed("not_allowed", outcome.message));
    return;
  }
  if (!(await approvalHolds(deps.verifier, call, TOOL, input))) {
    answer(failed("not_allowed", "This commit was not approved."));
    return;
  }
  // Only reaches the sandbox when the approval was immediate; otherwise `pending_approval` went first.
  const result = await commit();
  if (result.status !== "committed") {
    deps.log.warn({ run_id: frame.run_id, status: result.status }, "approved commit not written");
  }
  answer(replyOf(result));
}
