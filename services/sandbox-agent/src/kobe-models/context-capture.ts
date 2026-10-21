import { randomBytes } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The latest model call's context, as kobe-models handed it to Pi's API adapter (KOBE-470,
 * docs/specs/context-viewer.md): the provider records every session request's `context` (system
 * prompt, tool declarations, messages) with the answer's usage, so the agent can show the owner
 * exactly what the model saw. One file per Pi process, `KOBE_CONTEXT_FILE` in the process's private
 * `agent/` directory (the one Pi writes, which the thread's tools cannot under a Pi identity),
 * replaced atomically after each call and removed with the directory when Pi exits. Nothing leaves
 * the sandbox unless the owner opens the context viewer.
 *
 * Dependency-free (node builtins only), like the rest of kobe-models.
 */
export const CONTEXT_FILE_ENV = "KOBE_CONTEXT_FILE";
export const CONTEXT_FILE_NAME = "kobe-context.json";
export const CONTEXT_CAPTURE_VERSION = 1;
/** A larger capture is replaced by a stub (`too_large`); the viewer then rebuilds from the session. */
export const CONTEXT_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
/** 0640: Pi's own group is the agent's (KOBE-71), so the agent reads it; tools (partner uid) don't. */
const CAPTURE_MODE = 0o640;

export interface CapturedUsage {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface ContextCapture {
  readonly v: typeof CONTEXT_CAPTURE_VERSION;
  readonly captured_at: string;
  readonly model: { readonly id: string; readonly context_window: number | null };
  /** The answer's prompt tokens; null when the call reported none (failed before an answer). */
  readonly usage: CapturedUsage | null;
  /** Pi's request context: `{systemPrompt?, messages, tools?}`, images without their data. */
  readonly context?: unknown;
  readonly too_large?: true;
}

/** The capture file's location, taken from the environment once and removed from it. */
export function takeContextFilePath(env: Record<string, string | undefined>): string | undefined {
  const value = env[CONTEXT_FILE_ENV];
  Reflect.deleteProperty(env, CONTEXT_FILE_ENV);
  if (value === undefined || !value.startsWith("/")) return undefined;
  return value;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The prompt tokens an answer reported, or null when it reported none. */
export function promptUsage(result: unknown): CapturedUsage | null {
  const usage = (result as { usage?: unknown } | undefined)?.usage as
    Record<string, unknown> | undefined;
  if (typeof usage !== "object" || usage === null) return null;
  const counted = {
    input: num(usage.input),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
  };
  return counted.input + counted.cacheRead + counted.cacheWrite > 0 ? counted : null;
}

/** Image data is never kept: the block keeps its type and media type, and its size. */
function withoutImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImageData);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") {
    const { data, ...rest } = record;
    return { ...rest, data: "", data_chars: data.length };
  }
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, withoutImageData(v)]));
}

/** The file content for one call (a stub when the context is larger than the cap). */
export function captureText(
  model: { readonly id: string; readonly contextWindow?: number },
  context: unknown,
  result: unknown,
  now: Date,
): string {
  const base = {
    v: CONTEXT_CAPTURE_VERSION,
    captured_at: now.toISOString(),
    model: {
      id: model.id,
      context_window:
        typeof model.contextWindow === "number" && model.contextWindow > 0
          ? model.contextWindow
          : null,
    },
    usage: promptUsage(result),
  } satisfies Omit<ContextCapture, "context">;
  const full = JSON.stringify({ ...base, context: withoutImageData(context) });
  return Buffer.byteLength(full) > CONTEXT_CAPTURE_MAX_BYTES
    ? JSON.stringify({ ...base, too_large: true })
    : full;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = path.join(
    path.dirname(file),
    `${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temp, text, { mode: CAPTURE_MODE, flag: "wx" });
    await chmod(temp, CAPTURE_MODE);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** A temp file of the recorder (`kobe-context.json.<hex>.tmp`), for the agent's tripwire. */
export const isContextTemp = (name: string): boolean =>
  /^kobe-context\.json\.[0-9a-f]{16}\.tmp$/.test(name);

/**
 * Records the latest session request. Writes are serialized and only the newest pending one is
 * kept, so a burst of calls never queues up copies of the context. Summaries (compaction, branch
 * summaries: `cacheRetention: "none"`, pi 1.0.0 `completeSummarization`) are not the thread's
 * context and are skipped. A failed write only warns: the viewer then rebuilds from the session.
 */
export class ContextRecorder {
  readonly #file: string;
  readonly #write: (file: string, text: string) => Promise<void>;
  readonly #warn: (message: string) => void;
  readonly #now: () => Date;
  #pending: string | undefined;
  #running: Promise<void> | undefined;

  constructor(
    file: string,
    options: {
      write?: (file: string, text: string) => Promise<void>;
      warn?: (message: string) => void;
      now?: () => Date;
    } = {},
  ) {
    this.#file = file;
    this.#write = options.write ?? writeAtomic;
    this.#warn = options.warn ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
  }

  /** Called once the call ended (answered, failed or aborted). Never throws. */
  record(
    model: { readonly id: string; readonly contextWindow?: number },
    context: unknown,
    options: object | undefined,
    result: unknown,
  ): void {
    if ((options as { cacheRetention?: unknown } | undefined)?.cacheRetention === "none") return;
    try {
      this.#pending = captureText(model, context, result, this.#now());
    } catch (error) {
      this.#warn(`kobe-models: context not recorded: ${(error as Error).message}`);
      return;
    }
    this.#running ??= this.#drain();
  }

  /** Resolves once every recorded call is written (tests). */
  async settled(): Promise<void> {
    while (this.#running !== undefined) await this.#running;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending !== undefined) {
        const text = this.#pending;
        this.#pending = undefined;
        try {
          await this.#write(this.#file, text);
        } catch (error) {
          this.#warn(`kobe-models: context not recorded: ${(error as Error).message}`);
        }
      }
    } finally {
      this.#running = undefined;
    }
  }
}
