import {
  CAPABILITY_NOTEBOOK_START,
  CAPABILITY_NOTEBOOKS,
  CAPABILITY_RUN_TOKEN,
  CAPABILITY_SKILL_BUNDLES,
  CAPABILITY_SKILL_EVAL,
  CAPABILITY_THREAD_BRANCH_SUMMARY,
  CAPABILITY_THREAD_COMPACT,
  CAPABILITY_THREAD_CONTEXT,
  type RunStartFrame,
} from "@kobe/protocol";
import type { SandboxCommandKind } from "@kobe/db";
import type { CommandRow } from "../commands.js";
import { COMMAND_FAILURES, type CommandOutcome } from "../types.js";
import type { DeliveryEnv } from "./env.js";

/** A stored command this connection must not deliver; `endsRun`: its run fails with it. */
export interface DeliveryRefusal {
  readonly outcome: CommandOutcome;
  readonly endsRun: boolean;
}

const NOTEBOOK_COMMANDS: ReadonlySet<SandboxCommandKind> = new Set([
  "notebook.execute",
  "notebook.interrupt",
  "notebook.restart",
]);

export const failure = (code: string, message: string): CommandOutcome => ({
  ok: false,
  error: { code, message },
});

const refuse = (code: string, message: string): DeliveryRefusal => ({
  outcome: failure(code, message),
  endsRun: false,
});
const failRun = (code: string, message: string): DeliveryRefusal => ({
  outcome: failure(code, message),
  endsRun: true,
});

/**
 * Whether a stored command still lists image built-ins (`config.builtin_skills`, a run.start queued
 * before KOBE-317). Read from the stored JSON: the frame schema no longer knows the field and
 * parsing strips it (review-317 S1).
 */
function legacyBuiltins(row: CommandRow): boolean {
  const config = (row.frame as { config?: unknown }).config;
  const listed = (config as { builtin_skills?: unknown } | null | undefined)?.builtin_skills;
  return Array.isArray(listed) && listed.length > 0;
}

/**
 * Why this connection's agent can't take a stored command, before anything is claimed (KOBE-707:
 * moved out of delivery.ts, same checks in the same order); undefined when it can.
 */
export function deliveryRefusal(
  env: DeliveryEnv,
  row: CommandRow,
  frame: object,
): DeliveryRefusal | undefined {
  return kernelOrEvalRefusal(env, row) ?? runRefusal(env, row, frame);
}

function kernelOrEvalRefusal(env: DeliveryEnv, row: CommandRow): DeliveryRefusal | undefined {
  const { host } = env;
  // Skill eval commands (KOBE-325) only to a skill eval's own sandbox whose agent knows them.
  if (
    (row.kind === "eval.prepare" || row.kind === "eval.snapshot" || row.kind === "eval.read") &&
    (host.target.evalThreadId !== row.threadId || !host.hasCapability(CAPABILITY_SKILL_EVAL))
  ) {
    return refuse("skill_eval_unsupported", "this sandbox can't take skill eval commands");
  }
  // The thread kernel's commands (KOBE-464) only to an agent that runs kernels, never to an eval
  // sandbox.
  if (
    NOTEBOOK_COMMANDS.has(row.kind) &&
    (host.target.evalThreadId !== undefined || !host.hasCapability(CAPABILITY_NOTEBOOKS))
  ) {
    return refuse("notebooks_unsupported", "this sandbox runs no notebooks");
  }
  // Starting a kernel (KOBE-477) only to an agent that knows the op: an older one can't read it.
  if (
    row.kind === "notebook.restart" &&
    row.frame.op === "start" &&
    !host.hasCapability(CAPABILITY_NOTEBOOK_START)
  ) {
    return refuse(
      COMMAND_FAILURES.kernelStartUnsupported,
      "this sandbox can't start a kernel alone",
    );
  }
  // The context viewer (KOBE-470): the member's own sandbox only, and only an agent that knows it.
  if (
    row.kind === "thread.context" &&
    (host.target.evalThreadId !== undefined || !host.hasCapability(CAPABILITY_THREAD_CONTEXT))
  ) {
    return refuse(
      COMMAND_FAILURES.contextUnsupported,
      "this sandbox can't read a thread's context",
    );
  }
  return undefined;
}

function runRefusal(env: DeliveryEnv, row: CommandRow, frame: object): DeliveryRefusal | undefined {
  const { host, ctx } = env;
  // A stop still reaches a run the server already ended (Stop, budget, failed start): ending
  // it in Postgres first is what refuses its late frames, and Pi must still be told to abort.
  if (
    (row.kind === "run.steer" && !host.hasLiveLease(row.runId ?? "")) ||
    (row.kind === "run.stop" && !host.hasLease(row.runId ?? ""))
  ) {
    return refuse("run_not_active", "the run is not active on this sandbox");
  }
  if (
    row.kind === "run.start" &&
    (frame as RunStartFrame).config?.skill_bundles?.length &&
    !host.hasCapability(CAPABILITY_SKILL_BUNDLES)
  ) {
    // Never start a run without the skills it was resolved with, and never send fields the agent
    // doesn't know: an agent that can't materialize skills fails the run visibly.
    return failRun(
      COMMAND_FAILURES.skillsUnsupported,
      "this sandbox's agent is too old to load skills; it must be upgraded",
    );
  }
  if (row.kind === "run.start" && legacyBuiltins(row)) {
    // A run.start queued before KOBE-317 lists image built-ins, which no frame carries any more
    // (they are catalog bundles now): the run fails visibly rather than starting without the
    // skills it was resolved with. Sending it again resolves them as Kobe's catalog skills.
    return failRun(
      COMMAND_FAILURES.queuedBeforeUpgrade,
      "this run was queued before an upgrade and lists skills this sandbox no longer has; send it again",
    );
  }
  // A compaction summarizes with its run's token: never to an agent that can't take one.
  if (
    row.kind === "thread.compact" &&
    !(
      ctx.runTokenKey &&
      host.hasCapability(CAPABILITY_THREAD_COMPACT) &&
      host.hasCapability(CAPABILITY_RUN_TOKEN)
    )
  ) {
    return failRun(COMMAND_FAILURES.compactUnsupported, "this sandbox's agent can't compact");
  }
  // A branch summary likewise (KOBE-548).
  if (
    row.kind === "thread.branch_summary" &&
    !(
      ctx.runTokenKey &&
      host.hasCapability(CAPABILITY_THREAD_BRANCH_SUMMARY) &&
      host.hasCapability(CAPABILITY_RUN_TOKEN)
    )
  ) {
    return failRun(
      COMMAND_FAILURES.branchSummaryUnsupported,
      "this sandbox's agent can't summarize a branch",
    );
  }
  return undefined;
}
