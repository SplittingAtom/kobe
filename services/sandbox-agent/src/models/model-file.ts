import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { MODEL_FILE_VERSION, type ModelFileState } from "../kobe-models/protocol.js";
import type { RunModel } from "./types.js";

/**
 * The agent's side of the model file (kobe-models/protocol.ts): one per Pi process, in that
 * process's private runtime directory, rewritten atomically (a fresh random temp file opened `wx`
 * — no symlink or FIFO at the temp path is followed — then renamed, so Pi never reads a torn file)
 * on token rotation and run start/end. Writes are serialised so the last state asked for is the
 * one on disk; `verify` tells whether the disk still holds what was last written (the tripwire,
 * threads/thread.ts; under a Pi identity, KOBE-71, nobody but the agent can write it anyway).
 */
export interface ModelFileContent {
  readonly gatewayUrl: string;
  readonly model: RunModel | null;
  readonly token: string;
  readonly runId: string | null;
}

export function modelFileState(content: ModelFileContent): ModelFileState {
  return {
    v: MODEL_FILE_VERSION,
    gateway_url: content.gatewayUrl,
    model:
      content.model === null
        ? null
        : { gateway_model: content.model.gatewayModel, api: content.model.api },
    token: content.token,
    run_id: content.runId,
  };
}

function sameContent(a: ModelFileContent, b: ModelFileContent): boolean {
  return (
    a.token === b.token &&
    a.runId === b.runId &&
    a.model?.gatewayModel === b.model?.gatewayModel &&
    a.model?.api === b.model?.api
  );
}

export class ModelFile {
  readonly path: string;
  #content: ModelFileContent;
  /** What the last successful write put on disk (a failed write leaves it behind `#content`). */
  #written: ModelFileContent | undefined;
  #writtenText: string | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  readonly #mode: number;

  /**
   * `mode`: 0600 when Pi runs as the agent's uid; 0640 under a Pi identity (KOBE-71), where the
   * file's group is that Pi's own (the runtime directory is setgid), so only that Pi reads it and
   * nothing but the agent writes it.
   */
  constructor(path: string, initial: ModelFileContent, mode = 0o600) {
    this.path = path;
    this.#content = initial;
    this.#mode = mode;
  }

  get content(): ModelFileContent {
    return this.#content;
  }

  /** Write the initial content (call once, before Pi starts). */
  create(): Promise<void> {
    return this.#write(this.#content);
  }

  update(change: Partial<ModelFileContent>): Promise<void> {
    const next = { ...this.#content, ...change };
    // A no-op only when the disk already holds it: after a failed write, any update rewrites.
    if (this.#written === this.#content && sameContent(next, this.#content)) {
      return this.#chain.then(() => undefined);
    }
    this.#content = next;
    return this.#write(next);
  }

  /** True when the file on disk is byte for byte what this writer last wrote. */
  async verify(): Promise<boolean> {
    await this.#chain;
    if (this.#writtenText === undefined) return false;
    try {
      return (await readFile(this.path, "utf8")) === this.#writtenText;
    } catch {
      return false;
    }
  }

  #write(content: ModelFileContent): Promise<void> {
    const text = JSON.stringify(modelFileState(content));
    const temp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    const next = this.#chain.then(async () => {
      try {
        await writeFile(temp, text, { mode: this.#mode, flag: "wx" });
        // writeFile's mode is filtered by the umask: set it exactly.
        await chmod(temp, this.#mode);
        await rename(temp, this.path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      this.#written = content;
      this.#writtenText = text;
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }
}
