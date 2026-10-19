import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * Argument validation for MCP Apps' calls off the event loop (KOBE-436 review HIGH-1). A pinned
 * `inputSchema` comes from the upstream and may hold a `pattern` that backtracks exponentially
 * (`^(\w+\s?)*$` on 50 characters runs for hours), or combinators that blow up. Validation runs
 * in a small pool of worker threads with a hard deadline: a worker that misses it is terminated
 * and replaced, and the call is refused (`invalid_arguments`, audited). The server's event loop
 * never runs an upstream regular expression.
 *
 * The worker is evaluated from source (`eval: true`) and loads `@cfworker/json-schema` (an
 * interpreter: no code is generated from a schema) by its resolved path, so it works from
 * TypeScript sources in tests and from `dist` in the image alike.
 */
/**
 * `valid`; `invalid` (also a timeout or a failure: fail closed); or `busy` when the pool cannot
 * take the task: the owner already has one in flight or queued, the queue is full, or the pool
 * is closed (KOBE-436 re-review R-LOW-1). Busy is a capacity refusal, never a verdict.
 */
export type Validation = "valid" | "invalid" | "busy";

export interface SchemaValidator {
  /** `owner` (the member) holds at most one task in flight or queued. */
  validate(schema: unknown, instance: unknown, owner: string): Promise<Validation>;
  close(): Promise<void>;
}

export const VALIDATION_DEADLINE_MS = 100;
const POOL_SIZE = 2;
const MAX_QUEUE = 64;
/**
 * Heap caps per worker (re-review R-LOW-2): a schema or instance that allocates heavily ends the
 * worker (an `error` event), which is replaced, and the call is refused.
 */
export const WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
});

const LIBRARY = createRequire(import.meta.url).resolve("@cfworker/json-schema");

/** Worker source: one compiled validator per schema hash (LRU 128), one answer per message. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { Validator } = require(workerData.library);
const cache = new Map();
parentPort.on("message", ({ id, key, schema, instance }) => {
  let ok = false;
  try {
    let v = cache.get(key);
    if (!v) {
      v = new Validator(schema, "2020-12", true);
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(key, v);
    }
    ok = v.validate(instance).valid === true;
  } catch {
    ok = false;
  }
  parentPort.postMessage({ id, ok });
});
`;

interface Task {
  readonly id: number;
  readonly key: string;
  readonly schema: unknown;
  readonly instance: unknown;
  readonly owner: string;
  readonly resolve: (ok: boolean) => void;
}

interface Slot {
  worker: Worker;
  busy: Task | undefined;
  timer: NodeJS.Timeout | undefined;
}

export interface ValidatorPoolOptions {
  readonly size?: number;
  readonly deadlineMs?: number;
  readonly maxQueue?: number;
  /** Tests only: sees each worker as it is spawned. */
  readonly onSpawn?: (worker: Worker) => void;
}

export function createValidatorPool(options: ValidatorPoolOptions = {}): SchemaValidator {
  const deadline = options.deadlineMs ?? VALIDATION_DEADLINE_MS;
  const maxQueue = options.maxQueue ?? MAX_QUEUE;
  const queue: Task[] = [];
  /** Owners with a task in flight or queued. */
  const owners = new Set<string>();
  let nextId = 1;
  let closed = false;

  const spawn = (): Worker => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { library: LIBRARY },
      resourceLimits: { ...WORKER_RESOURCE_LIMITS },
    });
    worker.unref();
    options.onSpawn?.(worker);
    return worker;
  };

  const finish = (slot: Slot, ok: boolean) => {
    const task = slot.busy;
    if (slot.timer) clearTimeout(slot.timer);
    slot.busy = undefined;
    slot.timer = undefined;
    task?.resolve(ok);
    pump();
  };

  const attach = (slot: Slot) => {
    const worker = slot.worker;
    // Events of a worker already replaced are ignored.
    worker.on("message", (m: { id: number; ok: boolean }) => {
      if (slot.worker === worker && slot.busy?.id === m.id) finish(slot, m.ok);
    });
    worker.on("error", () => {
      if (slot.worker === worker) replace(slot);
    });
  };

  const replace = (slot: Slot) => {
    const old = slot.worker;
    void old.terminate();
    if (!closed) {
      slot.worker = spawn();
      attach(slot);
    }
    finish(slot, false);
  };

  const slots: Slot[] = Array.from({ length: options.size ?? POOL_SIZE }, () => {
    const slot: Slot = { worker: spawn(), busy: undefined, timer: undefined };
    attach(slot);
    return slot;
  });

  function pump(): void {
    for (const slot of slots) {
      if (slot.busy || queue.length === 0 || closed) continue;
      const task = queue.shift() as Task;
      slot.busy = task;
      // Missed deadline: terminate (a busy regex cannot be interrupted otherwise) and refuse.
      slot.timer = setTimeout(() => replace(slot), deadline);
      slot.timer.unref();
      slot.worker.postMessage({
        id: task.id,
        key: task.key,
        schema: task.schema,
        instance: task.instance,
      });
    }
  }

  return {
    validate(schema, instance, owner) {
      if (closed || queue.length >= maxQueue || owners.has(owner)) {
        return Promise.resolve("busy");
      }
      owners.add(owner);
      const key = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
      return new Promise<Validation>((resolve) => {
        const done = (ok: boolean) => {
          owners.delete(owner);
          resolve(ok ? "valid" : "invalid");
        };
        queue.push({ id: nextId++, key, schema, instance, owner, resolve: done });
        pump();
      });
    },
    async close() {
      closed = true;
      for (const task of queue.splice(0)) task.resolve(false);
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}
