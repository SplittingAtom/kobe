import type { SandboxTarget } from "./types.js";

// Wire slots (KOBE-325): which sandbox of a (team, user) a command or lease is for. `''` is the
// member's own sandbox; `e-<thread id>` the ephemeral sandbox of one skill-eval thread. The
// database enforces that a row's slot follows its thread (0146: check + trigger).

/** The slot of an eval thread's sandbox. */
export const evalSlot = (threadId: string): string => `e-${threadId}`;

/** The slot of a connection's or command's sandbox. */
export const slotOf = (target: SandboxTarget): string =>
  target.evalThreadId === undefined ? "" : evalSlot(target.evalThreadId);

/** Registry and log key of a sandbox: one live connection each. */
export const sandboxKey = (target: SandboxTarget): string =>
  `${target.teamId}:${target.userId}:${slotOf(target)}`;

/** The target of the sandbox that serves `threadId`, given whether it is an eval thread. */
export const targetForThread = (
  teamId: string,
  userId: string,
  threadId: string,
  skillEval: boolean,
): SandboxTarget => (skillEval ? { teamId, userId, evalThreadId: threadId } : { teamId, userId });
