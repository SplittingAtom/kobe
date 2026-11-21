import { sql, withTeam, type KobeTx } from "@kobe/db";
import type { PiGetEntriesData } from "@kobe/protocol";
import { appendRunEventsInTx, withAppendTx } from "../../event-stream/append.js";
import { failureInfo } from "../../runs/failure-codes.js";
import { keepRunPromptInTx, type PromptSource } from "../../runs/run-prompt.js";
import { mirrorBranchSummaryInTx, parseBranchSummaryResult } from "../branch-summary-end.js";
import { completeCommand } from "../commands.js";
import type { IssuedCommand } from "../delivery.js";
import { leafMovedEvents, mirrorEntriesInTx } from "../entries.js";
import { endRunInTx, runStillOpen } from "../run-state.js";
import {
  RUNTIME_TAMPERED,
  auditRuntimeTamperInTx,
  withTamperAudit,
  type RuntimeTamperReport,
} from "../runtime-tamper.js";
import type { CommandOutcome } from "../types.js";
import type { DeliveryEnv } from "./env.js";

/**
 * End-of-run settlement of delivered commands (KOBE-707: moved out of delivery.ts): a refused or
 * handled start, a compaction or branch summary answered, a runtime tampered with mid-run.
 */

/** What settlement needs from its delivery. */
export interface SettleEnv extends DeliveryEnv {
  /** New entries of a thread since the last mirrored one; undefined when unavailable. */
  fetchNewEntries(threadId: string): Promise<PiGetEntriesData | undefined>;
}

/** The sandbox stopped Pi for a tampered runtime: a security event (KOBE-271). */
export const tampered = (outcome: CommandOutcome): boolean =>
  !outcome.ok && outcome.error.code === RUNTIME_TAMPERED;

export async function endRun(
  env: SettleEnv,
  runId: string,
  threadId: string,
  outcome: CommandOutcome,
): Promise<void> {
  const { teamId } = env.host.target;
  // The sandbox's error code with the server's own message: its text is untrusted (logged above).
  const end = outcome.ok
    ? ({ status: "completed" } as const)
    : ({ status: "failed", error: failureInfo(outcome.error.code, "start_failed") } as const);
  // A refused start: Pi's entries say whether it holds the prompt (KOBE-290). Network I/O before
  // the transaction; unreadable entries keep nothing (Pi's own entry comes with the next sync).
  const read = outcome.ok ? undefined : await env.fetchNewEntries(threadId);
  const prompt: PromptSource | undefined =
    read === undefined ? undefined : { kind: "pi", entries: read, otherwise: "unsent" };
  const { ended } = await endTx(env, outcome, runId, threadId, "message", async (tx) => {
    const result = await endRunInTx(tx, teamId, runId, end, undefined, prompt, env.ctx.serverCalls);
    // Ended before (Stop while the sandbox prepared the run): the prompt is kept all the same.
    if (!result.ended && prompt !== undefined) {
      await keepRunPromptInTx(tx, teamId, runId, prompt, {
        leaf: "if_latest",
        maxEntries: env.ctx.tuning.threadMaxEntries,
        maxBytes: env.ctx.tuning.runMaxBytes,
      });
    }
    return result;
  });
  env.host.endLease(runId);
  if (ended) env.ctx.runEnded({ teamId, runId, threadId, status: end.status });
}

/**
 * A compaction answered (KOBE-213): Pi appended a `compaction` entry it does not announce, so
 * the thread's new entries are fetched and mirrored like a settled run's, then the run ends
 * (its token is revoked by the run end trigger). Pi's error text is logged, never stored.
 */
export async function endCompaction(
  env: SettleEnv,
  runId: string,
  threadId: string,
  outcome: CommandOutcome,
): Promise<void> {
  const { teamId } = env.host.target;
  if (!outcome.ok) {
    const detail = {
      run_id: runId,
      code: outcome.error.code,
      error: outcome.error.message.slice(0, 300),
    };
    // A tampered runtime is a security event: logged here, audited with the run end (KOBE-271).
    if (tampered(outcome)) {
      env.host.log.warn(
        { ...detail, sandbox_id: env.host.sandboxId, security: true },
        "compaction stopped: Pi's runtime was tampered with",
      );
    } else {
      env.host.log.info(detail, "compaction failed in the sandbox");
    }
  }
  const entries = outcome.ok ? await env.fetchNewEntries(threadId) : undefined;
  const end = outcome.ok
    ? ({ status: "completed" } as const)
    : ({ status: "failed", error: failureInfo(outcome.error.code, "start_failed") } as const);
  const { ended } = await endTx(env, outcome, runId, threadId, "compaction", async (tx) => {
    if (entries !== undefined) {
      const mirrored = await mirrorEntriesInTx(
        tx,
        teamId,
        threadId,
        entries,
        env.ctx.tuning.threadMaxEntries,
      );
      if (mirrored.capped) {
        env.host.log.warn({ thread_id: threadId }, "thread entry cap reached");
        env.ctx.auditLimit(env.host.target, env.host.sandboxId, "thread_entries");
      }
      // CT13: the compaction entry is the new leaf; its stream hears it before the end (a run
      // that already ended, e.g. cancelled, takes no more events).
      const moved = leafMovedEvents(threadId, mirrored.leafMovedTo);
      if (moved.length > 0 && (await runStillOpen(tx, teamId, runId))) {
        await appendRunEventsInTx(tx, teamId, runId, moved);
      }
    }
    return endRunInTx(tx, teamId, runId, end);
  });
  env.host.endLease(runId);
  if (ended) env.ctx.runEnded({ teamId, runId, threadId, status: end.status });
}

/**
 * A branch summary answered (KOBE-548, CT11): Pi appended a `branch_summary` entry, fetched and
 * mirrored like a compaction's; the reported entry becomes the thread's leaf and the run's stream
 * hears `thread.updated {leaf_entry_id}` before the run ends. A success whose entry did not
 * arrive (or is not a summary under the reported parent) fails the run `summary_failed` and
 * leaves the leaf. Pi's and the sandbox's text is logged, never stored.
 */
export async function endBranchSummary(
  env: SettleEnv,
  rowId: string,
  runId: string,
  threadId: string,
  outcome: CommandOutcome,
): Promise<void> {
  const { teamId } = env.host.target;
  if (!outcome.ok) {
    const detail = {
      run_id: runId,
      code: outcome.error.code,
      error: outcome.error.message.slice(0, 300),
    };
    if (tampered(outcome)) {
      env.host.log.warn(
        { ...detail, sandbox_id: env.host.sandboxId, security: true },
        "branch summary stopped: Pi's runtime was tampered with",
      );
    } else {
      env.host.log.info(detail, "branch summary failed in the sandbox");
    }
  }
  const reported = outcome.ok ? parseBranchSummaryResult(outcome.data) : undefined;
  if (outcome.ok && reported === undefined) {
    env.host.log.warn({ run_id: runId }, "the sandbox sent a malformed branch summary result");
  }
  const entries = reported !== undefined ? await env.fetchNewEntries(threadId) : undefined;
  const { ended, status } = await endTx(
    env,
    outcome,
    runId,
    threadId,
    "branch_summary",
    async (tx) => {
      let code = outcome.ok ? "summary_failed" : outcome.error.code;
      if (reported !== undefined) {
        const command = await tx.execute<{ to_entry_id: string | null }>(sql`
          SELECT frame ->> 'to_entry_id' AS to_entry_id FROM sandbox_commands
           WHERE team_id = ${teamId} AND id = ${rowId}`);
        const mirrored = await mirrorBranchSummaryInTx(tx, {
          toEntryId: command.rows[0]?.to_entry_id ?? "",
          teamId,
          threadId,
          runId,
          entries,
          reported,
          maxEntries: env.ctx.tuning.threadMaxEntries,
        });
        if (mirrored.capped) {
          env.host.log.warn({ thread_id: threadId }, "thread entry cap reached");
          env.ctx.auditLimit(env.host.target, env.host.sandboxId, "thread_entries");
        }
        if (mirrored.ok) code = "";
        else env.host.log.warn({ run_id: runId }, "the branch summary entry was not mirrored");
      }
      const end =
        code === ""
          ? ({ status: "completed" } as const)
          : ({ status: "failed", error: failureInfo(code, "start_failed") } as const);
      const result = await endRunInTx(tx, teamId, runId, end);
      return { ...result, status: end.status };
    },
  );
  env.host.endLease(runId);
  if (ended) env.ctx.runEnded({ teamId, runId, threadId, status });
}

/**
 * The transaction ending a run (`withAppendTx`). For a tampered runtime it also writes
 * `sandbox.runtime_tampered` as its last write, and the row alone if it cannot commit (KOBE-271).
 */
function endTx<T>(
  env: SettleEnv,
  outcome: CommandOutcome,
  runId: string,
  threadId: string,
  runKind: RuntimeTamperReport["runKind"],
  work: (tx: KobeTx) => Promise<T>,
): Promise<T> {
  const { db } = env.ctx;
  const { teamId } = env.host.target;
  if (!tampered(outcome)) return withAppendTx(db, teamId, work);
  const report = tamperReport(env, runId, threadId, runKind);
  return withTamperAudit(db, report, env.host.log, () =>
    withAppendTx(db, teamId, async (tx) => {
      const result = await work(tx);
      await auditRuntimeTamperInTx(tx, report);
      return result;
    }),
  );
}

/**
 * A `pi.command` (the wire's own `get_entries`, or a row's) was answered `runtime_tampered`: the
 * agent stopped the thread's Pi as an expected close, ended its run there and sends no
 * `pi.exited` (KOBE-607). Every live message run of the thread is failed `runtime_tampered` with
 * its audit row and its lease ended, so it neither stays `running` nor blocks hibernation.
 * Compactions and branch summaries are left alone: their own result ends them.
 */
export async function tamperedMidRun(
  env: SettleEnv,
  threadId: string,
  outcome: CommandOutcome,
): Promise<void> {
  if (outcome.ok) return;
  const runs = env.host.liveMessageRuns(threadId);
  env.host.log.warn(
    {
      thread_id: threadId,
      run_ids: runs,
      sandbox_id: env.host.sandboxId,
      error: outcome.error.message.slice(0, 300),
      security: true,
    },
    "Pi stopped mid-run: its runtime was tampered with",
  );
  const { teamId } = env.host.target;
  const end = {
    status: "failed",
    error: failureInfo(outcome.error.code, "start_failed"),
  } as const;
  for (const runId of runs) {
    try {
      const { ended } = await endTx(env, outcome, runId, threadId, "message", (tx) =>
        endRunInTx(tx, teamId, runId, end),
      );
      env.host.endLease(runId);
      if (ended) env.ctx.runEnded({ teamId, runId, threadId, status: end.status });
    } catch (err) {
      // The row was written on its own (withTamperAudit); the lost-run sweep ends the run.
      env.host.endLease(runId);
      env.host.log.error({ err, run_id: runId }, "could not end a run stopped for tampering");
    }
  }
}

/** The ids of a tampered-runtime report from this connection (KOBE-271). */
function tamperReport(
  env: SettleEnv,
  runId: string,
  threadId: string,
  runKind: RuntimeTamperReport["runKind"],
): RuntimeTamperReport {
  const { teamId, userId } = env.host.target;
  const { sandboxId } = env.host;
  return { teamId, userId, sandboxId, replicaId: env.ctx.replicaId, threadId, runId, runKind };
}

/**
 * Records a delivered row command's outcome for its requester; a compaction or branch summary ends
 * its run first, a `pi.command` refused for a tampered runtime ends the thread's runs, and a refused
 * or handled `run.start` ends its run (KOBE-23).
 */
export async function recordResult(
  env: SettleEnv,
  issued: Extract<IssuedCommand, { kind: "row" }>,
  outcome: CommandOutcome,
): Promise<void> {
  const { teamId } = env.host.target;
  // The compaction's entry is mirrored and its run ended before its requester hears back; if
  // that fails the requester still hears back (and ends the run itself).
  if (issued.commandKind === "thread.compact" && issued.runId !== null) {
    await endCompaction(env, issued.runId, issued.threadId, outcome).catch((err: unknown) =>
      env.host.log.error({ err, run_id: issued.runId }, "could not end a compaction run"),
    );
  }
  if (issued.commandKind === "thread.branch_summary" && issued.runId !== null) {
    await endBranchSummary(env, issued.rowId, issued.runId, issued.threadId, outcome).catch(
      (err: unknown) =>
        env.host.log.error({ err, run_id: issued.runId }, "could not end a branch summary run"),
    );
  }
  // A row `pi.command` refused for a tampered runtime: the agent stopped that thread's Pi.
  if (issued.commandKind === "pi.command" && tampered(outcome)) {
    await tamperedMidRun(env, issued.threadId, outcome).catch((err: unknown) =>
      env.host.log.error({ err, thread_id: issued.threadId }, "could not end tampered runs"),
    );
  }
  await withTeam(env.ctx.db, teamId, (tx) =>
    completeCommand(tx, env.ctx.bus, teamId, issued.rowId, outcome, env.host.id),
  );
  if (issued.requesterReplica === env.ctx.replicaId) env.ctx.localResult(issued.rowId);
  if (issued.commandKind !== "run.start" || issued.runId === null) return;
  // A rejected prompt, or one Pi handled without starting work, ends the run without
  // `agent_settled` (KOBE-23).
  const handled =
    outcome.ok &&
    (outcome.data as { disposition?: unknown } | undefined)?.disposition === "handled";
  if (!outcome.ok || handled) await endRun(env, issued.runId, issued.threadId, outcome);
}
