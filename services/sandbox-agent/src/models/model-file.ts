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

export class ModelFile {
  readonly path: string;
  #content: ModelFileContent;
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
    if (
      next.token === this.#content.token &&
      next.runId === this.#content.runId &&
      next.model?.gatewayModel === this.#content.model?.gatewayModel &&
      next.model?.api === this.#content.model?.api
    ) {
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
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }
}
