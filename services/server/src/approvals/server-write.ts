import { approvalModeSchema } from "@kobe/protocol";
import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { AppendError, appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { readApprovalFloor, strictestApprovalMode } from "../policy/approval-floor.js";
import { loadApprovalForCall } from "./store.js";
import type { ApprovalVerifier } from "./verify.js";

/**
 * Shared steps of a server-side write that needs the signed approval of exactly one tool call
 * (project `remember`, KOBE-156; `propose_project_file`, KOBE-162): whether the policy check
 * already got an approval, whether the run may ask a person at all (D32), and the verification and
 * consumption of the approval against the canonical input. The caller owns the order of steps.
 */
export interface CallRef {
  readonly teamId: string;
  readonly userId: string;
  readonly runId: string;
  readonly toolCallId: string;
}

/** Whether an approval row exists for this call already (the policy check may have got it). */
export async function hasApproval(db: KobeDb, call: CallRef): Promise<boolean> {
  const row = await withTeam(db, call.teamId, (tx) =>
    loadApprovalForCall(tx, call.teamId, call.runId, call.toolCallId),
  );
  return row !== undefined;
}

/** Verifies and consumes the signed approval of this call over exactly `input`. */
export async function approvalHolds(
  verifier: ApprovalVerifier | undefined,
  call: CallRef,
  tool: string,
  input: unknown,
): Promise<boolean> {
  if (!verifier) return false;
  const check = await verifier.authorize({ ...call, tool, input, enforcementPoint: "server" });
  return check.ok;
}

export type NoPromptCode = "scheduled_run_no_prompt" | "mode_auto_not_allowlisted";

/** Why this run may not ask a person, if it may not (scheduled run or `auto` approval mode). */
export async function noPromptCode(db: KobeDb, call: CallRef): Promise<NoPromptCode | undefined> {
  // The effective mode, as the policy check computes it: scheduled runs are `auto`; otherwise the
  // run's mode clamped to the install floor as it is now (the floor may have risen since).
  const { trigger, mode, floor } = await withTeam(db, call.teamId, async (tx) => {
    const res = await tx.execute<{ trigger: string; approval_mode: string }>(sql`
      SELECT trigger, approval_mode FROM runs WHERE team_id = ${call.teamId} AND id = ${call.runId}`);
    const run = res.rows[0];
    return {
      trigger: run?.trigger,
      mode: approvalModeSchema.safeParse(run?.approval_mode),
      floor: await readApprovalFloor(tx),
    };
  });
  if (trigger === "schedule") return "scheduled_run_no_prompt";
  const requested = mode.success ? mode.data : "ask-on-write";
  return strictestApprovalMode(requested, floor) === "auto"
    ? "mode_auto_not_allowlisted"
    : undefined;
}

async function appendDenied(
  tx: KobeTx,
  call: CallRef,
  tool: string,
  runMaxEvents: number,
  code: NoPromptCode,
): Promise<void> {
  const run = await tx.execute<{ last_seq: number }>(sql`
    SELECT last_seq FROM runs WHERE team_id = ${call.teamId} AND id = ${call.runId}`);
  if ((run.rows[0]?.last_seq ?? runMaxEvents) + 2 > runMaxEvents) return;
  await appendRunEventsInTx(tx, call.teamId, call.runId, [
    {
      type: "policy.denied",
      payload: {
        tool_call_id: call.toolCallId,
        tool,
        reasons: [
          {
            code,
            stage: "approval_mode",
            message: "This run does not wait for approvals, so the project write was skipped.",
          },
        ],
      },
    },
  ]);
}

/**
 * The denied write as the same `policy.denied` event the policy check records, which is what the
 * run report's skipped actions are built from. TODO(KOBE-178): attach `skipped_actions` to the
 * terminal event once the run-report plumbing reads them.
 */
export async function recordDeniedWrite(
  db: KobeDb,
  log: Pick<Logger, "warn">,
  call: CallRef,
  tool: string,
  runMaxEvents: number,
  code: NoPromptCode,
): Promise<void> {
  try {
    await withAppendTx(db, call.teamId, (tx) => appendDenied(tx, call, tool, runMaxEvents, code));
  } catch (err) {
    if (!(err instanceof AppendError)) {
      log.warn({ err, run_id: call.runId }, "could not record the skipped project write");
    }
  }
}
