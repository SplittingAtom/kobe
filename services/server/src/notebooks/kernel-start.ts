import {
  notebookStartResultSchema,
  type ActorContext,
  type NotebookStartResponse,
} from "@kobe/protocol";
import { hitRateLimit } from "../rate-limit.js";
import { lockOwnedThread } from "../runs/access.js";
import { COMMAND_FAILURES, SandboxWakeError } from "../sandbox-wire/types.js";
import { NotebookRunError, type NotebookRunHost } from "./user-run.js";

/**
 * Start the thread's kernel without running code (KOBE-477, docs/specs/notebooks.md NB19): the
 * owner only. A sandbox that is not connected is woken and the answer is 202 `waking` (the web
 * asks again, as the context viewer does); a connected one gets `notebook.restart` with
 * `op: "start"` and the answer is the kernel's state (`idle` / `busy`). Nothing is stored: no
 * run, no event. A wake refused (no gVisor/Kata runtime, not ready in time) is reported to the
 * next start instead of answering 202 for ever.
 */
/** How soon the web asks again while the sandbox wakes: 12 asks a minute, well under the limit. */
export const KERNEL_START_RETRY_MS = 5_000;
/** Starts per member per minute (as the context viewer's reads): each may wake or command. */
export const KERNEL_START_RATE_LIMIT = { windowMs: 60_000, max: 30 };
/** How long a start waits for the wake to be refused at once (isolation, membership checks). */
export const KERNEL_START_REFUSAL_WAIT_MS = 1_500;
/** A refused wake is reported to the member's next start within this long. */
export const KERNEL_START_REFUSAL_MEMORY_MS = 120_000;
/** The kernel's own start budget (60 s in the agent) plus a margin. */
export const KERNEL_START_COMMAND_MS = 90_000;
const MAX_REMEMBERED_REFUSALS = 10_000;

type Host = Pick<
  NotebookRunHost,
  "db" | "router" | "log" | "isolationMissing" | "threadTx" | "assertMayRun"
>;

/** Wakes this replica saw refused, by team and user (per replica, like the context viewer's). */
export class WakeRefusals {
  readonly #at = new Map<string, number>();

  remember(key: string): void {
    if (this.#at.size >= MAX_REMEMBERED_REFUSALS) this.#at.clear();
    this.#at.set(key, Date.now());
  }

  /** Whether a refusal is recent; reading forgets it (the next start tries again). */
  take(key: string): boolean {
    const at = this.#at.get(key);
    this.#at.delete(key);
    return at !== undefined && Date.now() - at < KERNEL_START_REFUSAL_MEMORY_MS;
  }
}

const refusedError = () =>
  new NotebookRunError("sandbox_refused", "Your sandbox could not be started; try again later.");

export async function startKernel(
  host: Host,
  refusals: WakeRefusals,
  actor: ActorContext,
  threadId: string,
): Promise<NotebookStartResponse> {
  if (host.isolationMissing()) {
    throw new NotebookRunError("isolation_unavailable", "Sandboxes are unavailable right now.");
  }
  // The owner, still allowed to run (account active, still a member), as for Run.
  await host.threadTx(actor, async (tx, viewer) => {
    await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
    await host.assertMayRun(tx, actor);
  });
  if (!(await hitRateLimit(host.db, `notebook-start:${actor.user_id}`, KERNEL_START_RATE_LIMIT))) {
    throw new NotebookRunError("rate_limited", "Too many kernel starts; wait a minute.");
  }
  const target = { teamId: actor.team_id, userId: actor.user_id };
  if (!(await host.router.isConnected(target, threadId))) {
    return wake(host, refusals, target);
  }
  const outcome = await host.router.notebookKernel(
    target,
    { threadId, op: "start" },
    { timeoutMs: KERNEL_START_COMMAND_MS },
  );
  if (!outcome.ok) {
    const code = outcome.error.code;
    host.log.warn({ code, thread_id: threadId }, "notebook kernel start failed");
    if (code === "notebooks_unsupported" || code === COMMAND_FAILURES.kernelStartUnsupported) {
      throw new NotebookRunError(
        "notebooks_unsupported",
        "Your sandbox can't start a kernel on its own yet; run a cell to start it.",
      );
    }
    throw new NotebookRunError("sandbox_unavailable", "The kernel did not start; try again.");
  }
  const parsed = notebookStartResultSchema.safeParse(outcome.data);
  if (!parsed.success) {
    throw new NotebookRunError("sandbox_unavailable", "Your workspace gave an unexpected answer.");
  }
  return parsed.data;
}

async function wake(
  host: Host,
  refusals: WakeRefusals,
  target: { readonly teamId: string; readonly userId: string },
): Promise<NotebookStartResponse> {
  const key = `${target.teamId}:${target.userId}`;
  if (refusals.take(key)) throw refusedError();
  // Like sending (D14): the sandbox wakes; the web shows progress and asks again.
  const waking = host.router.wake(target).then(
    () => "woken" as const,
    (err: unknown) => {
      if (err instanceof SandboxWakeError) {
        refusals.remember(key);
        host.log.info({ team_id: target.teamId, code: err.code }, "kernel start wake refused");
        return "refused" as const;
      }
      host.log.warn({ err, team_id: target.teamId }, "kernel start wake failed");
      return "failed" as const;
    },
  );
  const early = await Promise.race([
    waking,
    new Promise<"pending">((resolve) =>
      setTimeout(() => resolve("pending"), KERNEL_START_REFUSAL_WAIT_MS).unref(),
    ),
  ]);
  if (early === "refused") {
    refusals.take(key);
    throw refusedError();
  }
  return { status: "waking", retry_after_ms: KERNEL_START_RETRY_MS };
}
