import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { SYSTEM_PROMPT_MAX_BYTES } from "@kobe/protocol";

/**
 * The agent's system prompt as Pi 1.0.0 takes it (KOBE-123). Pi's `--append-system-prompt <text|file>`
 * reads the value as a file when a file of that name exists, else uses it as literal text; Kobe
 * always passes a path. It is an append, not `--system-prompt` (a replace): Pi's default prompt
 * carries the tool and skill descriptions, so replacing it would leave the model without them.
 *
 * The file lives in the thread's per-process runtime directory (models/runtime-dir.ts), which the
 * agent owns and no Pi tool can write into (under a Pi identity, KOBE-71: agent-owned, Pi's group
 * may read; without one, the tripwire `verify` catches a rewrite). It is written once per launch
 * and removed with the directory when Pi exits, so nothing carries over to another thread.
 */
export const SYSTEM_PROMPT_FILE_NAME = "system-prompt.md";
export const APPEND_SYSTEM_PROMPT_FLAG = "--append-system-prompt";

export function systemPromptArgs(file: string): readonly string[] {
  return [APPEND_SYSTEM_PROMPT_FLAG, file];
}

export class SystemPromptFile {
  readonly path: string;
  readonly #text: string;
  readonly #mode: number;

  /** `mode`: 0600 when Pi runs as the agent's uid, 0640 under a Pi identity (Pi's group reads). */
  constructor(path: string, text: string, mode = 0o600) {
    if (Buffer.byteLength(text, "utf8") > SYSTEM_PROMPT_MAX_BYTES)
      throw new Error(`system prompt exceeds ${SYSTEM_PROMPT_MAX_BYTES} bytes`);
    this.path = path;
    this.#text = text;
    this.#mode = mode;
  }

  /** Exclusive create (never follows a planted link), then the exact mode. */
  async write(): Promise<void> {
    try {
      await writeFile(this.path, this.#text, { mode: this.#mode, flag: "wx" });
      await chmod(this.path, this.#mode);
    } catch (error) {
      await rm(this.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** The tripwire: a regular file holding exactly what was written. */
  async verify(): Promise<boolean> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile()) return false;
      return (await readFile(this.path, "utf8")) === this.#text;
    } catch {
      return false;
    }
  }
}
