/**
 * Kernel executions as the web sees them (KOBE-465; events NB15): one store per chat session,
 * fed by the thread's run streams (the agent's `run_python` calls) and by the streams of the
 * member's own `notebook` runs, so the open notebook shows both live. Assembled from
 * `notebook.started` / `notebook.output` / `notebook.finished`; a replayed event changes nothing.
 * Immutable snapshots for `useSyncExternalStore`.
 */
import type {
  KobeEvent,
  KobeEventPayload,
  NotebookExecStatus,
  NotebookOutput,
} from "@kobe/protocol";

export interface ExecutionEnd {
  readonly status: NotebookExecStatus;
  readonly executionCount: number | null;
  readonly truncated: boolean;
  /** The `.ipynb` version holding the outputs; null when nothing was saved. */
  readonly saved: { readonly path: string; readonly sha256: string } | null;
  readonly saveError?: string | undefined;
}

export interface Execution {
  readonly threadId: string;
  readonly runId: string;
  readonly execId: string;
  readonly origin: "user" | "agent";
  readonly toolCallId?: string | undefined;
  readonly path?: string | undefined;
  readonly cellId?: string | undefined;
  /** By index; a gap (an output not arrived yet) is undefined. */
  readonly outputs: readonly (NotebookOutput | undefined)[];
  readonly finished?: ExecutionEnd | undefined;
}

export interface BlockedDomain {
  readonly runId: string;
  readonly payload: KobeEventPayload<"egress.blocked">;
}

type Listener = () => void;

/** Executions kept per session; the oldest are forgotten first. */
export const EXECUTIONS_KEPT = 200;

const RUN_END_STATUS: Partial<Record<KobeEvent["type"], NotebookExecStatus>> = {
  "run.completed": "failed",
  "run.failed": "failed",
  "run.budget_stopped": "failed",
  "run.interrupted": "interrupted",
};

export class NotebookExecStore {
  #execs: readonly Execution[] = [];
  #egress: readonly BlockedDomain[] = [];
  #listeners: readonly Listener[] = [];
  readonly #max: number;

  constructor(max = EXECUTIONS_KEPT) {
    this.#max = max;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  snapshot = (): readonly Execution[] => this.#execs;

  egress = (): readonly BlockedDomain[] => this.#egress;

  /** Run `runId` ended without its executions' end reaching this tab: they end `failed`. */
  endRun(runId: string): void {
    const execs = this.#execs;
    if (!execs.some((e) => e.runId === runId && e.finished === undefined)) return;
    this.#execs = endExecutions(execs, runId, "failed");
    for (const l of this.#listeners) l();
  }

  /** A batch of one run's events of thread `threadId`, in seq order. */
  apply(threadId: string, events: readonly KobeEvent[]): void {
    let execs = this.#execs;
    let egress = this.#egress;
    for (const event of events) {
      execs = applyOne(execs, threadId, event);
      if (event.type === "egress.blocked") egress = withBlocked(egress, event);
    }
    if (execs === this.#execs && egress === this.#egress) return;
    this.#execs = execs.length > this.#max ? execs.slice(execs.length - this.#max) : execs;
    this.#egress = egress;
    for (const l of this.#listeners) l();
  }
}

function withBlocked(egress: readonly BlockedDomain[], event: KobeEvent): readonly BlockedDomain[] {
  if (event.type !== "egress.blocked") return egress;
  const known = egress.some(
    (b) => b.runId === event.run_id && b.payload.domain === event.payload.domain,
  );
  return known ? egress : [...egress, { runId: event.run_id, payload: event.payload }];
}

function endExecutions(
  execs: readonly Execution[],
  runId: string,
  status: NotebookExecStatus,
): readonly Execution[] {
  return execs.map((e) =>
    e.runId === runId && e.finished === undefined
      ? { ...e, finished: { status, executionCount: null, truncated: false, saved: null } }
      : e,
  );
}

function update(
  execs: readonly Execution[],
  execId: string,
  change: (e: Execution) => Execution,
): readonly Execution[] {
  const at = execs.findIndex((e) => e.execId === execId);
  if (at < 0) return execs;
  const current = execs[at] as Execution;
  const next = change(current);
  return next === current ? execs : execs.map((e, i) => (i === at ? next : e));
}

function applyOne(
  execs: readonly Execution[],
  threadId: string,
  event: KobeEvent,
): readonly Execution[] {
  switch (event.type) {
    case "notebook.started": {
      const p = event.payload;
      if (execs.some((e) => e.execId === p.exec_id)) return execs;
      return [
        ...execs,
        {
          threadId,
          runId: event.run_id,
          execId: p.exec_id,
          origin: p.origin,
          toolCallId: p.tool_call_id,
          path: p.path,
          cellId: p.cell_id,
          outputs: [],
        },
      ];
    }
    case "notebook.output": {
      const { exec_id, index, output } = event.payload;
      return update(execs, exec_id, (e) => {
        if (e.outputs[index] !== undefined) return e;
        const outputs = [...e.outputs];
        outputs[index] = output;
        return { ...e, outputs };
      });
    }
    case "notebook.finished": {
      const p = event.payload;
      return update(execs, p.exec_id, (e) =>
        e.finished !== undefined
          ? e
          : {
              ...e,
              finished: {
                status: p.status,
                executionCount: p.execution_count,
                truncated: p.truncated,
                saved: p.saved,
                saveError: p.save_error,
              },
            },
      );
    }
    default: {
      const status = RUN_END_STATUS[event.type];
      if (status === undefined) return execs;
      if (!execs.some((e) => e.runId === event.run_id && e.finished === undefined)) return execs;
      return endExecutions(execs, event.run_id, status);
    }
  }
}

/** The newest execution of this file (and cell: undefined for a whole `.py` file) in the thread. */
export function latestRun(
  execs: readonly Execution[],
  threadId: string,
  path: string,
  cellId?: string,
): Execution | undefined {
  for (let i = execs.length - 1; i >= 0; i--) {
    const e = execs[i] as Execution;
    if (e.threadId === threadId && e.path === path && e.cellId === cellId) return e;
  }
  return undefined;
}

/** Whether the thread's kernel is running something now. */
export function kernelBusy(execs: readonly Execution[], threadId: string): boolean {
  return execs.some((e) => e.threadId === threadId && e.finished === undefined);
}

/** The agent's `run_python {code}` executions in the thread (not tied to a file). */
export function agentCodeRuns(execs: readonly Execution[], threadId: string): readonly Execution[] {
  return execs.filter((e) => e.threadId === threadId && e.origin === "agent" && !e.path);
}

/** Domains blocked during the member's own runs of this file (NB17): the egress notice. */
export function egressNotices(
  execs: readonly Execution[],
  egress: readonly BlockedDomain[],
  threadId: string,
  path: string,
): readonly BlockedDomain[] {
  const runs = new Set(
    execs
      .filter((e) => e.threadId === threadId && e.origin === "user" && e.path === path)
      .map((e) => e.runId),
  );
  return egress.filter((b) => runs.has(b.runId));
}
