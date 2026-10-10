import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";

/**
 * The per-run memory file (KOBE-157): `<runtimeDir>/memory-context.json`, agent-owned like the model
 * file (0600, or 0640 under a Pi identity), rewritten atomically before every prompt. The kobe-tools
 * extension reads it (kobe-tools/memory-hooks.ts), so a changed memory index is not a changed
 * launch and never restarts Pi. `verify` is the tripwire: it must still be what the agent wrote.
 */
export const MEMORY_FILE_NAME = "memory-context.json";
export const MEMORY_FILE_ENV = "KOBE_MEMORY_FILE";

export interface MemoryFileContent {
  readonly tools: boolean;
  readonly text: string;
}

export const isMemoryTemp = (name: string): boolean =>
  name.startsWith(`${MEMORY_FILE_NAME}.`) && name.endsWith(".tmp");

export class MemoryContextFile {
  readonly path: string;
  readonly #mode: number;
  #writtenText: string | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string, mode = 0o600) {
    this.path = path;
    this.#mode = mode;
  }

  write(content: MemoryFileContent): Promise<void> {
    const text = JSON.stringify({ tools: content.tools, text: content.text });
    const temp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    const next = this.#chain.then(async () => {
      try {
        await writeFile(temp, text, { mode: this.#mode, flag: "wx" });
        await chmod(temp, this.#mode);
        await rename(temp, this.path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      this.#writtenText = text;
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async verify(): Promise<boolean> {
    await this.#chain;
    if (this.#writtenText === undefined) return false;
    try {
      return (await readFile(this.path, "utf8")) === this.#writtenText;
    } catch {
      return false;
    }
  }
}
