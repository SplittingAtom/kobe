"use client";

/**
 * The thread's kernel from the artifact column (KOBE-465): run a cell or a `.py` file (a
 * `notebook` run whose events this tab follows into the session's execution store, NB6),
 * interrupt and restart it (NB7), and what the kernel is doing. The agent's `run_python` calls
 * reach the same store through the thread's own stream.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NotebookRunBody } from "@kobe/protocol";
import type { ApiError } from "../../lib/api/client";
import type { ChatApi } from "../../lib/chat/api";
import { openRunStream, type EventSourceFactory, type RunStream } from "../../lib/chat/stream";
import type { NotebookApi } from "../../lib/notebooks/api";
import { kernelBusy, NotebookExecStore, type Execution } from "../../lib/notebooks/executions";

/** What the notebook and the `.py` pane need from the chat: the thread and the stores. */
export interface KernelWiring {
  /** The conversation whose kernel runs the code; null before the first message. */
  readonly threadId: string | null;
  readonly api: NotebookApi;
  readonly runs: NotebookExecStore;
  readonly teamId: string;
  /** Request access on an egress notice (NB17). */
  readonly egressApi?: Pick<ChatApi, "requestEgressAccess" | "egressRequests"> | undefined;
  /** Tests drive the run streams without a browser. */
  readonly eventSource?: EventSourceFactory | undefined;
}

export type KernelNote =
  | { readonly kind: "none" }
  | { readonly kind: "working"; readonly text: string }
  | { readonly kind: "done"; readonly text: string }
  | { readonly kind: "error"; readonly error: ApiError };

const BUSY_RETRIES = 12;
const BUSY_RETRY_MS = 250;

const KERNEL_STATUS: Readonly<Record<string, string>> = {
  interrupted: "Interrupted the running code.",
  restarted: "Kernel restarted: its variables are cleared.",
  idle: "The kernel was idle.",
  no_kernel: "No kernel is running; the next run starts one.",
};

export function useExecutions(runs: NotebookExecStore): readonly Execution[] {
  return useSyncExternalStore(runs.subscribe, runs.snapshot, runs.snapshot);
}

/** Resolves when execution `execId` (already in the store) has finished, or is forgotten. */
export function whenFinished(runs: NotebookExecStore, execId: string): Promise<Execution | null> {
  return new Promise((resolve) => {
    const check = () => {
      const exec = runs.snapshot().find((e) => e.execId === execId);
      if (exec !== undefined && exec.finished === undefined) return false;
      unsubscribe();
      resolve(exec ?? null);
      return true;
    };
    const unsubscribe = runs.subscribe(() => void check());
    check();
  });
}

export function useKernel(wiring: KernelWiring | undefined) {
  const [note, setNote] = useState<KernelNote>({ kind: "none" });
  const streams = useRef(new Set<RunStream>());
  const execs = useExecutions(wiring?.runs ?? EMPTY_STORE);
  const threadId = wiring?.threadId ?? null;
  const busy = threadId !== null && kernelBusy(execs, threadId);

  useEffect(() => {
    const open = streams.current;
    return () => {
      for (const s of open) s.close();
      open.clear();
    };
  }, []);

  /** Starts a run; resolves with its execution id, or null (the note says why). */
  const run = useCallback(
    async (body: NotebookRunBody): Promise<string | null> => {
      if (!wiring || wiring.threadId === null) return null;
      const thread = wiring.threadId;
      setNote({ kind: "none" });
      let res = await wiring.api.run(thread, body);
      // The previous run ends just after its execution's end: give it a moment (Run all).
      for (let i = 0; i < BUSY_RETRIES && !res.ok && res.error.code === "thread_busy"; i++) {
        await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
        res = await wiring.api.run(thread, body);
      }
      if (!res.ok) {
        setNote({ kind: "error", error: res.error });
        return null;
      }
      const { runId, execId } = res.data;
      // Shown as running at once; the run's own `notebook.started` then changes nothing.
      wiring.runs.apply(thread, [
        {
          run_id: runId,
          seq: 0,
          ts: new Date().toISOString(),
          type: "notebook.started",
          payload: {
            exec_id: execId,
            origin: "user",
            path: body.path,
            ...(body.cell_id === undefined ? {} : { cell_id: body.cell_id }),
          },
        },
      ]);
      const stream = openRunStream(
        runId,
        0,
        {
          onEvents: (events) => wiring.runs.apply(thread, events),
          onSignal: (signal) => {
            if (signal.kind !== "closed") return;
            streams.current.delete(stream);
            // Ended without its terminal event reaching this tab (refused, compacted): stop
            // showing it as running.
            wiring.runs.endRun(runId);
          },
        },
        wiring.eventSource,
      );
      streams.current.add(stream);
      return execId;
    },
    [wiring],
  );

  const kernel = useCallback(
    async (op: "interrupt" | "restart") => {
      if (!wiring || wiring.threadId === null) return;
      setNote({
        kind: "working",
        text: op === "interrupt" ? "Interrupting…" : "Restarting the kernel…",
      });
      const res = await wiring.api.kernel(wiring.threadId, op);
      setNote(
        res.ok
          ? { kind: "done", text: KERNEL_STATUS[res.data.status] ?? "" }
          : { kind: "error", error: res.error },
      );
    },
    [wiring],
  );

  return { execs, busy, note, run, kernel, threadId };
}

/** For a view without a thread's kernel: never changes. */
const EMPTY_STORE = new NotebookExecStore();
