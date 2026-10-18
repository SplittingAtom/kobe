import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { RULE_SET_VERSION, type ScanResult } from "@kobe/skill-scanner";

/**
 * Skill scans off the event loop (KOBE-313 review A-S2). A scan is CPU-bound and can take
 * seconds on a crafted bundle, so each runs in a worker thread: at most `concurrency` at once
 * (later ones queue), each killed after `timeoutMs`. A scan that times out is Block
 * `scan-incomplete`, never Pass. The worker unzips and scans with the same `@kobe/skill-scanner`
 * this process loads, so results are identical to an in-process scan.
 */
export interface ScanOptions {
  /**
   * Who asked (a user id, or e.g. `team:<id>` for late scans): at most
   * {@link SCAN_PER_OWNER} of their scans run or wait at once. Background rescans pass none and
   * only queue behind the others (they run one at a time anyway).
   */
  readonly owner?: string;
  /**
   * A Workbench scan preview (KOBE-321 review S1/S2): same worker, limits and rules as a save, so
   * the verdicts agree, but it never waits (no free slot: {@link ScanBusyError} `global`) and it
   * gives its slot up to any upload, save or rescan that arrives while it runs (rejected with
   * {@link ScanCancelledError}). Previews never delay real scans.
   */
  readonly preview?: boolean;
  /** Aborting it while the scan runs stops the worker ({@link ScanCancelledError}). */
  readonly signal?: AbortSignal;
}

export interface ScanPool {
  /** Rejects with {@link ScanBusyError} when the queue (or the owner's share) is full. */
  scan(zip: Uint8Array, options?: ScanOptions): Promise<ScanResult>;
  /** Whether a preview would get a slot now (checked before any work is done for one). */
  canStartPreview?(): boolean;
}

/** A scan stopped before its result: its caller aborted it, or a real scan took its slot. */
export class ScanCancelledError extends Error {
  constructor(readonly reason: "aborted" | "preempted") {
    super(`skill scan cancelled (${reason})`);
    this.name = "ScanCancelledError";
  }
}

/** The scan queue is full: try again later (`owner`: this caller's share; `global`: everyone's). */
export class ScanBusyError extends Error {
  constructor(readonly kind: "owner" | "global") {
    super(`skill scan queue full (${kind})`);
    this.name = "ScanBusyError";
  }
}

/** Seconds a caller turned away by a full queue should wait (about one scan). */
export const SCAN_RETRY_AFTER_SECONDS = 10;

export const SCAN_CONCURRENCY = 2;
export const SCAN_TIMEOUT_MS = 30_000;
/** Scans waiting (beyond those running) across the process; more are turned away. */
export const SCAN_MAX_QUEUED = 8;
/** Scans one owner may have running or waiting. */
export const SCAN_PER_OWNER = 2;
/**
 * Each worker's heap (KOBE-313 re-review: two crafted uploads at once peaked at 1.5 GB without it;
 * 192 MiB old generation keeps the pod near 0.7 GB). A worker that needs more is killed and the
 * bundle is Block `scan-resources-exceeded`.
 */
export const SCAN_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 192,
  maxYoungGenerationSizeMb: 32,
} as const;

const require = createRequire(import.meta.url);
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(require.resolve(name)).href);

/** The worker: an ES module from a data URL that imports the resolved scanner and fflate. */
const WORKER_SOURCE = `
import { parentPort } from "node:worker_threads";
import { scanSkillBundle } from ${moduleUrl("@kobe/skill-scanner")};
import * as fflate from ${moduleUrl("fflate")};
const unzipSync = fflate.unzipSync ?? fflate.default.unzipSync;
parentPort.once("message", (zip) => {
  try {
    const entries = unzipSync(zip);
    const files = Object.entries(entries).map(([path, bytes]) => ({ path, bytes }));
    parentPort.postMessage({ ok: true, result: scanSkillBundle(files) });
  } catch (err) {
    parentPort.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
});
`;
const WORKER_URL = new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`);

/** A scan that could not finish: Block, so a slow or huge bundle never buys a Pass. */
function blockedScan(rule: string, excerpt: string): ScanResult {
  return {
    verdict: "block",
    ruleSetVersion: RULE_SET_VERSION,
    scripts: [],
    findings: [
      {
        category: "limit",
        rule,
        file: "SKILL.md",
        line: 0,
        excerpt,
        severity: "block",
      },
    ],
    skipped: [],
  };
}

/** The scan ran out of time. */
export const incompleteScan = () =>
  blockedScan("scan-incomplete", "The scan did not finish in time.");
/** The scan's worker ran out of memory or crashed. */
export const resourcesExceededScan = () =>
  blockedScan("scan-resources-exceeded", "The scan needed more memory than a scan may use.");

type Reply = { ok: true; result: ScanResult } | { ok: false; message: string };

interface Running {
  readonly preview: boolean;
  cancel: (reason: ScanCancelledError["reason"]) => void;
}

function runInWorker(
  zip: Uint8Array,
  timeoutMs: number,
  resourceLimits: NonNullable<ConstructorParameters<typeof Worker>[1]>["resourceLimits"],
  job: { cancel?: (reason: ScanCancelledError["reason"]) => void },
): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { resourceLimits });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      finish();
    };
    job.cancel = (reason) => settle(() => reject(new ScanCancelledError(reason)));
    const timer = setTimeout(() => settle(() => resolve(incompleteScan())), timeoutMs);
    worker.once("message", (reply: Reply) =>
      settle(() =>
        reply.ok ? resolve(reply.result) : reject(new Error(`skill scan failed: ${reply.message}`)),
      ),
    );
    // Out of memory (ERR_WORKER_OUT_OF_MEMORY) or any crash: the bundle is Block, never a 500.
    worker.once("error", () => settle(() => resolve(resourcesExceededScan())));
    worker.once("exit", () => settle(() => resolve(resourcesExceededScan())));
    worker.postMessage(zip);
  });
}

export function createScanPool(
  options: {
    readonly concurrency?: number;
    readonly timeoutMs?: number;
    readonly maxQueued?: number;
    readonly perOwner?: number;
    readonly resourceLimits?: {
      maxOldGenerationSizeMb?: number;
      maxYoungGenerationSizeMb?: number;
    };
  } = {},
): ScanPool {
  const concurrency = options.concurrency ?? SCAN_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS;
  const maxQueued = options.maxQueued ?? SCAN_MAX_QUEUED;
  const perOwner = options.perOwner ?? SCAN_PER_OWNER;
  const limits = options.resourceLimits ?? SCAN_RESOURCE_LIMITS;
  let active = 0;
  const waiting: (() => void)[] = [];
  const owners = new Map<string, number>();
  // A slot is taken synchronously, and handed straight to the next waiter on release.
  const acquire = (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  const running = new Set<Running>();
  /** A real scan found every slot taken: the first running preview gives its slot up. */
  const preemptPreview = () => {
    for (const job of running) {
      if (job.preview) {
        job.cancel("preempted");
        return;
      }
    }
  };
  return {
    canStartPreview: () => active < concurrency,
    async scan(zip, scanOptions = {}) {
      const { preview = false, signal } = scanOptions;
      // Previews don't count toward the owner's share (re-review): an editor left open never
      // turns its author's uploads away. The Workbench keeps one preview per author itself.
      const owner = preview ? undefined : scanOptions.owner;
      if (signal?.aborted) throw new ScanCancelledError("aborted");
      if (owner !== undefined && (owners.get(owner) ?? 0) >= perOwner)
        throw new ScanBusyError("owner");
      // A preview takes a free slot or none; it never queues.
      if (preview && active >= concurrency) throw new ScanBusyError("global");
      const previewRunning = [...running].some((j) => j.preview);
      // Background scans (no owner) wait their turn; callers who asked are turned away when full,
      // unless a preview holds a slot they can take.
      if (
        owner !== undefined &&
        active >= concurrency &&
        waiting.length >= maxQueued &&
        !previewRunning
      )
        throw new ScanBusyError("global");
      if (owner !== undefined) owners.set(owner, (owners.get(owner) ?? 0) + 1);
      try {
        const slot = acquire();
        if (!preview && active >= concurrency && waiting.length > 0) preemptPreview();
        await slot;
        const job: Running = { preview, cancel: () => undefined };
        const onAbort = () => job.cancel("aborted");
        running.add(job);
        try {
          const result = runInWorker(zip, timeoutMs, limits, job);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
          return await result;
        } finally {
          signal?.removeEventListener("abort", onAbort);
          running.delete(job);
          release();
        }
      } finally {
        if (owner !== undefined) {
          const left = (owners.get(owner) ?? 1) - 1;
          if (left > 0) owners.set(owner, left);
          else owners.delete(owner);
        }
      }
    },
  };
}

let shared: ScanPool | undefined;
/** The process-wide pool (uploads, late scans and rescans share its concurrency cap). */
export function scanPool(): ScanPool {
  shared ??= createScanPool();
  return shared;
}

/** Replaces the process-wide pool (tests); returns the previous one. */
export function setScanPool(pool: ScanPool | undefined): ScanPool | undefined {
  const previous = shared;
  shared = pool;
  return previous;
}
