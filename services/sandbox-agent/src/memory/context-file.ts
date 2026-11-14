import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../atomic-file.js";
import type { SemanticSection } from "./semantic-context.js";

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
  /** The Notes section (KOBE-157); empty with Notes off. */
  readonly text: string;
  /**
   * What Kobe knows, stable part (KOBE-383: title, preamble, Policy, pinned items): first in the
   * run's additions, with or without Notes. Absent when the run has no semantic memory.
   */
  readonly known?: string;
  /** The per-message picks and the overflow line (KOBE-383): after the project instructions. */
  readonly picks?: string;
  /** The context viewer's sections of `known` / `picks` (agent memory only, not in the file). */
  readonly knownSections?: readonly SemanticSection[];
  readonly picksSections?: readonly SemanticSection[];
  /** Project instructions block (KOBE-245); empty for a non-project run. */
  readonly project: string;
  /** The viewed-file section (KOBE-462); empty when the run has none. */
  readonly viewing?: string;
  /** Sync conflicts told at the run's start (KOBE-492): in its system prompt; empty without. */
  readonly conflicts?: string;
  /** Sync conflicts told mid-run (KOBE-492): a custom message before each later model call. */
  readonly conflictsLive?: string;
  /** The viewer may edit the run's project (KOBE-580): kobe-tools lists `commit_project`. */
  readonly projectWrite?: boolean;
}

export const isMemoryTemp = (name: string): boolean =>
  name.startsWith(`${MEMORY_FILE_NAME}.`) && name.endsWith(".tmp");

export class MemoryContextFile {
  readonly path: string;
  readonly #mode: number;
  #writtenText: string | undefined;
  #written: MemoryFileContent | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string, mode = 0o600) {
    this.path = path;
    this.#mode = mode;
  }

  write(content: MemoryFileContent): Promise<void> {
    const text = JSON.stringify({
      tools: content.tools,
      text: content.text,
      known: content.known ?? "",
      picks: content.picks ?? "",
      project: content.project,
      viewing: content.viewing ?? "",
      conflicts: content.conflicts ?? "",
      conflicts_live: content.conflictsLive ?? "",
      project_write: content.projectWrite === true,
    });
    const next = this.#chain.then(async () => {
      await writeFileAtomic(this.path, text, this.#mode);
      this.#writtenText = text;
      this.#written = content;
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** What the agent last wrote (the context viewer splits the prompt by it, KOBE-470). */
  get written(): MemoryFileContent | undefined {
    return this.#written;
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
