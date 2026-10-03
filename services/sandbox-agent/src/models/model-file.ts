import { rename, writeFile } from "node:fs/promises";
import { MODEL_FILE_VERSION, type ModelFileState } from "../kobe-models/protocol.js";
import type { RunModel } from "./types.js";

/**
 * The agent's side of the model file (kobe-models/protocol.ts): one per Pi process, in that
 * process's private runtime directory, rewritten atomically (temp file + rename, so Pi never reads
 * a torn file) on token rotation and run start/end. Writes are serialised so the last state asked
 * for is the one on disk.
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
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string, initial: ModelFileContent) {
    this.path = path;
    this.#content = initial;
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

  #write(content: ModelFileContent): Promise<void> {
    const text = JSON.stringify(modelFileState(content));
    const temp = `${this.path}.tmp`;
    const next = this.#chain.then(async () => {
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, this.path);
      this.#written = content;
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }
}
