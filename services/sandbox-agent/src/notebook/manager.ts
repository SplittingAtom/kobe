import type {
  NotebookExecuteFrame,
  NotebookExecuteResult,
  NotebookKernelResponse,
  NotebookOutput,
} from "@kobe/protocol";
import { fail, ok, type CommandOutcome } from "../threads/outcome.js";
import { OUTPUT_LIMITS, OutputLimiter, type OutputLimits } from "./outputs.js";
import { KernelSession, type BridgeLauncher } from "./session.js";

/**
 * The thread kernels of one sandbox (KOBE-464; docs/specs/notebooks.md NB2, NB7, NB8, NB10). A
 * kernel starts on its thread's first `notebook.execute`, runs one execution at a time (the rest
 * wait in order), stops after `idleMs` without use, on `notebook.restart` and when the agent stops.
 * At most `maxKernels` live at once: a new one first stops the least recently used idle kernel,
 * and is refused (`kernel_unavailable`) when every kernel is busy. Each execution has a deadline
 * counted from its arrival (waiting included): at `timeout_ms` the kernel is interrupted, `graceMs`
 * later it is stopped (state lost). An execution still waiting is never run once its deadline
 * passed, its run ended, or the thread was interrupted: the server has given up on it (NB8).
 */
export interface KernelManagerOptions {
  readonly launch: BridgeLauncher;
  readonly maxKernels: number;
  readonly idleMs: number;
  readonly readyTimeoutMs?: number;
  readonly graceMs?: number;
  readonly limits?: OutputLimits;
  readonly log: (message: string, threadId?: string) => void;
}

export const KERNEL_READY_TIMEOUT_MS = 60_000;
export const KERNEL_GRACE_MS = 5_000;

type ExecStatus = NotebookExecuteResult["status"];

/** An execution waiting for its kernel: cancelled by an interrupt or the end of its run. */
interface Waiting {
  readonly runId: string;
  readonly deadlineAt: number;
  cancelled: boolean;
}

interface Kernel {
  readonly threadId: string;
  readonly session: KernelSession;
  /** Executions of this kernel, chained so they run one at a time. */
  tail: Promise<unknown>;
  queued: number;
  lastUsed: number;
  idle: NodeJS.Timeout | undefined;
  /** Why the kernel is being stopped while an execution runs (decides that execution's status). */
  stopping: ExecStatus | undefined;
  current: { readonly runId: string; readonly execId: string } | undefined;
  readonly waiting: Set<Waiting>;
}

export type OutputSink = (index: number, output: NotebookOutput) => void;

export class KernelManager {
  readonly #o: KernelManagerOptions;
  readonly #kernels = new Map<string, Kernel>();
  readonly #starting = new Map<string, Promise<Kernel>>();
  #closed = false;

  constructor(options: KernelManagerOptions) {
    this.#o = options;
  }

  get size(): number {
    return this.#kernels.size;
  }

  /** `notebook.execute`: runs the code, streams outputs to `sink`, answers how it ended. */
  async execute(frame: NotebookExecuteFrame, sink: OutputSink): Promise<CommandOutcome> {
    if (this.#closed) return fail("kernel_unavailable", "the sandbox is stopping");
    const waiting: Waiting = {
      runId: frame.run_id,
      deadlineAt: Date.now() + frame.timeout_ms,
      cancelled: false,
    };
    let kernel: Kernel;
    try {
      kernel = await this.#kernelFor(frame.thread_id);
    } catch (error) {
      this.#o.log(`kernel start failed: ${(error as Error).message}`, frame.thread_id);
      return fail("kernel_unavailable", (error as Error).message);
    }
    kernel.queued += 1;
    kernel.waiting.add(waiting);
    const run = kernel.tail.then(() => this.#run(kernel, frame, sink, waiting));
    kernel.tail = run.catch(() => undefined);
    try {
      return ok(await run);
    } catch (error) {
      return fail("internal", (error as Error).message);
    } finally {
      kernel.queued -= 1;
      kernel.waiting.delete(waiting);
      this.#touch(kernel);
    }
  }

  /**
   * `notebook.interrupt` (also the member's Stop): SIGINT to the running cell (state kept), and
   * every execution still waiting is dropped.
   */
  interrupt(threadId: string): CommandOutcome {
    const kernel = this.#kernels.get(threadId);
    if (kernel === undefined) return ok(this.#status("no_kernel"));
    for (const w of kernel.waiting) w.cancelled = true;
    const dropped = kernel.waiting.size > 0;
    if (!kernel.session.busy) return ok(this.#status(dropped ? "interrupted" : "idle"));
    kernel.session.interrupt();
    return ok(this.#status("interrupted"));
  }

  /** `notebook.restart`: stops the kernel; the next execution starts a fresh one. */
  async restart(threadId: string): Promise<CommandOutcome> {
    const kernel = this.#kernels.get(threadId);
    if (kernel === undefined) return ok(this.#status("no_kernel"));
    await this.#stop(kernel, "restarted", "restarted by the user");
    return ok(this.#status("restarted"));
  }

  /** A run ended (Stop, failure, Pi gone): its running cell is interrupted, its waiting ones dropped. */
  runEnded(runId: string): void {
    for (const kernel of this.#kernels.values()) {
      for (const w of kernel.waiting) if (w.runId === runId) w.cancelled = true;
      if (kernel.current?.runId === runId && kernel.session.busy) kernel.session.interrupt();
    }
  }

  /** The agent stops (hibernation, SIGTERM): every kernel goes (NB2). */
  async stopAll(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#kernels.values()].map((k) => this.#stop(k, "restarted")));
  }

  #status(status: NotebookKernelResponse["status"]): NotebookKernelResponse {
    return { status };
  }

  async #run(
    kernel: Kernel,
    frame: NotebookExecuteFrame,
    sink: OutputSink,
    waiting: Waiting,
  ): Promise<NotebookExecuteResult> {
    const limiter = new OutputLimiter(sink, this.#o.limits ?? OUTPUT_LIMITS);
    kernel.waiting.delete(waiting);
    if (waiting.cancelled) {
      limiter.note("[Kobe: not run: interrupted, or its run ended, before it started]\n");
      return { status: "interrupted", execution_count: null, ...limiter.finish() };
    }
    const remaining = waiting.deadlineAt - Date.now();
    if (remaining <= 0) {
      limiter.note("[Kobe: not run: its time ran out while it waited for the kernel]\n");
      return { status: "timeout", execution_count: null, ...limiter.finish() };
    }
    if (!kernel.session.alive) {
      limiter.note("[Kobe: the kernel stopped before this cell ran; run it again]\n");
      return { status: "restarted", execution_count: null, ...limiter.finish() };
    }
    kernel.current = { runId: frame.run_id, execId: frame.exec_id };
    let timedOut = false;
    const grace = this.#o.graceMs ?? KERNEL_GRACE_MS;
    let kill: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      kernel.session.interrupt();
      kill = setTimeout(() => void this.#stop(kernel, "timeout", "the cell timed out"), grace);
    }, remaining);
    try {
      const result = await kernel.session.execute(frame.exec_id, frame.code, (o) =>
        limiter.push(o),
      );
      if (result.kind === "done") {
        const status: ExecStatus = timedOut ? "timeout" : result.status;
        if (timedOut) limiter.note(`[Kobe: the cell ran past its ${frame.timeout_ms / 1000} s]\n`);
        return { status, execution_count: result.executionCount, ...limiter.finish() };
      }
      // The bridge or the kernel went away.
      const status: ExecStatus = kernel.stopping ?? (timedOut ? "timeout" : "error");
      limiter.note(stopNote(status));
      void this.#stop(kernel, status, result.message);
      return { status, execution_count: null, ...limiter.finish() };
    } finally {
      clearTimeout(deadline);
      if (kill !== undefined) clearTimeout(kill);
      kernel.current = undefined;
    }
  }

  async #kernelFor(threadId: string): Promise<Kernel> {
    const live = this.#kernels.get(threadId);
    if (live !== undefined && live.session.alive) return live;
    if (live !== undefined) await this.#stop(live, "restarted");
    const pending = this.#starting.get(threadId);
    if (pending !== undefined) return pending;
    const starting = this.#start(threadId).finally(() => this.#starting.delete(threadId));
    this.#starting.set(threadId, starting);
    return starting;
  }

  async #start(threadId: string): Promise<Kernel> {
    await this.#makeRoom();
    const proc = await this.#o.launch(threadId);
    const session = new KernelSession(proc, (m) => this.#o.log(m, threadId));
    try {
      await session.ready(this.#o.readyTimeoutMs ?? KERNEL_READY_TIMEOUT_MS);
    } catch (error) {
      await session.stop("start failed").catch(() => undefined);
      throw error;
    }
    if (this.#closed) {
      await session.stop("the sandbox is stopping");
      throw new Error("the sandbox is stopping");
    }
    const kernel: Kernel = {
      threadId,
      session,
      tail: Promise.resolve(),
      queued: 0,
      lastUsed: Date.now(),
      idle: undefined,
      stopping: undefined,
      current: undefined,
      waiting: new Set(),
    };
    this.#kernels.set(threadId, kernel);
    this.#o.log("kernel started", threadId);
    return kernel;
  }

  /** Below the cap, or the least recently used idle kernel is stopped; else refused. */
  async #makeRoom(): Promise<void> {
    if (this.#kernels.size + this.#starting.size < this.#o.maxKernels) return;
    const idle = [...this.#kernels.values()]
      .filter((k) => k.queued === 0 && !k.session.busy)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (idle === undefined) {
      throw new Error(`all ${this.#o.maxKernels} kernels of this sandbox are busy; try again`);
    }
    await this.#stop(idle, "restarted", "stopped to make room for another thread's kernel");
  }

  #touch(kernel: Kernel): void {
    kernel.lastUsed = Date.now();
    if (kernel.idle !== undefined) clearTimeout(kernel.idle);
    kernel.idle = undefined;
    if (kernel.queued > 0 || this.#kernels.get(kernel.threadId) !== kernel) return;
    kernel.idle = setTimeout(() => {
      if (kernel.queued === 0 && !kernel.session.busy) {
        void this.#stop(kernel, "restarted", "idle");
      }
    }, this.#o.idleMs);
    kernel.idle.unref();
  }

  async #stop(kernel: Kernel, why: ExecStatus, reason = "stopped"): Promise<void> {
    kernel.stopping ??= why;
    if (kernel.idle !== undefined) clearTimeout(kernel.idle);
    if (this.#kernels.get(kernel.threadId) === kernel) this.#kernels.delete(kernel.threadId);
    this.#o.log(`kernel stopped: ${reason}`, kernel.threadId);
    await kernel.session.stop(reason).catch((error: unknown) => {
      this.#o.log(`stopping a kernel failed: ${(error as Error).message}`, kernel.threadId);
    });
  }
}

function stopNote(status: ExecStatus): string {
  if (status === "restarted") return "[Kobe: the kernel was restarted; its state is lost]\n";
  if (status === "timeout") return "[Kobe: the cell timed out and the kernel was stopped]\n";
  return "[Kobe: the kernel stopped unexpectedly; its state is lost]\n";
}
