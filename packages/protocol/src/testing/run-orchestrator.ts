import type { ActorContext } from "../common.js";
import type {
  RunOrchestrator,
  RunSnapshot,
  RunTransition,
  RunTransitionListener,
} from "../run-orchestrator.js";
import {
  canTransition,
  isActiveRunStatus,
  isTerminalRunStatus,
  type RunStatus,
  type RunTransitionCause,
} from "../runs.js";

/**
 * In-memory fake of the run orchestrator (test use only). Keeps the contract's invariants — the
 * transition table, one active run per thread, FIFO queue, team scoping — and nothing else: no Pi,
 * no sandbox, no events. Tests drive Pi-side progress with `advance(runId, to, cause)`.
 */
export class RunContractError extends Error {
  constructor(
    readonly code: "run_not_found" | "invalid_transition",
    message: string,
  ) {
    super(message);
    this.name = "RunContractError";
  }
}

export interface FakeRunOrchestrator extends RunOrchestrator {
  /** Simulate progress reported by the sandbox (approval requested, settled, sandbox lost, ...). */
  advance(runId: string, to: RunStatus, cause: RunTransitionCause): RunSnapshot;
  readonly steers: readonly { run_id: string; content: string }[];
}

export function createFakeRunOrchestrator(now: () => Date = () => new Date()): FakeRunOrchestrator {
  let runs = new Map<string, RunSnapshot>();
  let order: readonly string[] = [];
  let steers: readonly { run_id: string; content: string }[] = [];
  let listeners: readonly RunTransitionListener[] = [];
  let counter = 0;

  const threadRuns = (teamId: string, threadId: string) =>
    order
      .map((id) => runs.get(id))
      .filter(
        (r): r is RunSnapshot =>
          r !== undefined && r.team_id === teamId && r.thread_id === threadId,
      );

  const find = (actor: ActorContext | { team_id: string }, runId: string): RunSnapshot => {
    const run = runs.get(runId);
    if (run === undefined || run.team_id !== actor.team_id) {
      throw new RunContractError("run_not_found", `run ${runId} not found`);
    }
    return run;
  };

  const save = (run: RunSnapshot) => {
    runs = new Map([...runs, [run.run_id, run]]);
    return run;
  };

  const renumberQueue = (teamId: string, threadId: string) => {
    threadRuns(teamId, threadId)
      .filter((r) => r.status === "queued")
      .forEach((r, index) => save({ ...r, queue_pos: index + 1 }));
  };

  function transition(run: RunSnapshot, to: RunStatus, cause: RunTransitionCause): RunSnapshot {
    if (!canTransition(run.status, to, cause)) {
      throw new RunContractError(
        "invalid_transition",
        `${run.status} → ${to} (${cause}) is not allowed`,
      );
    }
    const at = now().toISOString();
    const { queue_pos: _drop, ...rest } = run;
    const next = save({
      ...rest,
      status: to,
      ...(to === "running" && run.started_at === undefined ? { started_at: at } : {}),
      ...(isTerminalRunStatus(to) ? { ended_at: at } : {}),
    });
    const event: RunTransition = { run: next, from: run.status, to, cause, at };
    listeners.forEach((listener) => listener(event));
    if (isTerminalRunStatus(to)) promoteNext(next.team_id, next.thread_id);
    renumberQueue(next.team_id, next.thread_id);
    return next;
  }

  function promoteNext(teamId: string, threadId: string): void {
    const all = threadRuns(teamId, threadId);
    if (all.some((r) => isActiveRunStatus(r.status))) return;
    const next = all.find((r) => r.status === "queued");
    if (next !== undefined) transition(next, "running", "dequeued");
  }

  function create(actor: ActorContext, threadId: string, extra: Partial<RunSnapshot>): RunSnapshot {
    counter += 1;
    const run = save({
      run_id: `run_${counter}`,
      thread_id: threadId,
      team_id: actor.team_id,
      status: "queued",
      trigger: "user",
      approval_mode: "ask-on-write",
      ...extra,
    });
    order = [...order, run.run_id];
    renumberQueue(actor.team_id, threadId);
    promoteNext(actor.team_id, threadId);
    return find(actor, run.run_id);
  }

  return {
    get steers() {
      return steers;
    },
    submitMessage(actor, command) {
      const run = create(actor, command.thread_id, {
        trigger: command.trigger,
        approval_mode:
          command.trigger === "schedule" ? "auto" : (command.approval_mode ?? "ask-on-write"),
      });
      return Promise.resolve({ run_id: run.run_id, queued: run.status === "queued" });
    },
    steer(actor, runId, body) {
      const run = find(actor, runId);
      if (!isActiveRunStatus(run.status)) {
        return Promise.reject(
          new RunContractError("invalid_transition", `cannot steer a ${run.status} run`),
        );
      }
      steers = [...steers, { run_id: runId, content: body.content }];
      return Promise.resolve(run);
    },
    cancel(actor, runId) {
      return Promise.resolve().then(() =>
        transition(find(actor, runId), "cancelled", "user_cancelled"),
      );
    },
    updateQueued(actor, runId) {
      const run = find(actor, runId);
      if (run.status !== "queued") {
        return Promise.reject(
          new RunContractError("invalid_transition", "only queued runs can be edited"),
        );
      }
      return Promise.resolve(run);
    },
    retry(actor, runId) {
      const run = find(actor, runId);
      if (run.status !== "interrupted") {
        return Promise.reject(
          new RunContractError("invalid_transition", "only interrupted runs can be retried"),
        );
      }
      const next = create(actor, run.thread_id, {
        retry_of_run_id: run.run_id,
        approval_mode: run.approval_mode,
      });
      return Promise.resolve({ run_id: next.run_id, queued: next.status === "queued" });
    },
    getRun(actor, runId) {
      return Promise.resolve().then(() => find(actor, runId));
    },
    listThreadRuns(actor, threadId) {
      const all = threadRuns(actor.team_id, threadId);
      return Promise.resolve([
        ...all.filter((r) => isActiveRunStatus(r.status)),
        ...all.filter((r) => r.status === "queued"),
      ]);
    },
    stopForBudget(command) {
      // Queued first so stopping an active run does not promote a run we are about to stop.
      // The fake stops immediately and ignores `user_id`; the real one waits for the step to end.
      const affected = [...runs.values()]
        .filter((r) => r.team_id === command.team_id && !isTerminalRunStatus(r.status))
        .sort((a, b) => Number(isActiveRunStatus(a.status)) - Number(isActiveRunStatus(b.status)));
      affected.forEach((r) => transition(find(r, r.run_id), "budget_stopped", "budget_exhausted"));
      return Promise.resolve(affected.map((r) => r.run_id));
    },
    // The fake has one sandbox per team, so `sandboxId` is ignored.
    markSandboxLost(teamId) {
      const affected = [...runs.values()].filter(
        (r) => r.team_id === teamId && isActiveRunStatus(r.status),
      );
      affected.forEach((r) => transition(find(r, r.run_id), "interrupted", "sandbox_lost"));
      return Promise.resolve(affected.map((r) => r.run_id));
    },
    onTransition(listener) {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    advance(runId, to, cause) {
      const run = runs.get(runId);
      if (run === undefined) throw new RunContractError("run_not_found", `run ${runId} not found`);
      return transition(run, to, cause);
    },
  };
}
