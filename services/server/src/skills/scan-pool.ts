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
export interface ScanPool {
  scan(zip: Uint8Array): Promise<ScanResult>;
}

export const SCAN_CONCURRENCY = 2;
export const SCAN_TIMEOUT_MS = 30_000;

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

/** The result of a scan that ran out of time: Block, so a slow bundle never buys a Pass. */
export function incompleteScan(): ScanResult {
  return {
    verdict: "block",
    ruleSetVersion: RULE_SET_VERSION,
    scripts: [],
    findings: [
      {
        category: "limit",
        rule: "scan-incomplete",
        file: "SKILL.md",
        line: 0,
        excerpt: "The scan did not finish in time.",
        severity: "block",
      },
    ],
    skipped: [],
  };
}

type Reply = { ok: true; result: ScanResult } | { ok: false; message: string };

function runInWorker(zip: Uint8Array, timeoutMs: number): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL);
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(incompleteScan());
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.once("message", (reply: Reply) => {
      done();
      if (reply.ok) resolve(reply.result);
      else reject(new Error(`skill scan failed: ${reply.message}`));
    });
    worker.once("error", (err) => {
      done();
      reject(err);
    });
    worker.postMessage(zip);
  });
}

export function createScanPool(
  options: { readonly concurrency?: number; readonly timeoutMs?: number } = {},
): ScanPool {
  const concurrency = options.concurrency ?? SCAN_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS;
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  const slot = () =>
    active < concurrency
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiting.push(resolve));
  return {
    async scan(zip) {
      await slot();
      active += 1;
      try {
        return await runInWorker(zip, timeoutMs);
      } finally {
        release();
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
