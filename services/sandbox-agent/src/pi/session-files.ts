import { randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { uuidSchema, type PiSessionEntry, type PiSessionHeader } from "@kobe/protocol";
import { LineSplitter, encodeJsonl } from "../jsonl.js";
import { assertOnVolume, shareOnVolume } from "../workspace/volume.js";
import { PI_MAX_LINE_BYTES } from "./pi-process.js";

/**
 * Pi session JSONL files, one per Kobe thread, on the workspace volume. Postgres is the record
 * (D15); these files are a rebuildable copy (`session.restore`, D13). The agent writes a thread's
 * file only while no Pi process runs for that thread.
 */
export function sessionFilePath(sessionDir: string, threadId: string): string {
  // thread ids are validated uuids already; re-check so no caller can traverse out of the dir.
  if (!uuidSchema.safeParse(threadId).success) throw new Error("invalid thread id");
  return path.join(sessionDir, `${threadId}.jsonl`);
}

export interface SessionDirOptions {
  /**
   * Pi identities (KOBE-71): Pi runs under other uids, which reach the session files through the
   * workspace group. The directories become 2770 and the files the agent owns 0660 (agents before
   * KOBE-71 made them 0700/0600) — once per process.
   */
  readonly shared?: boolean;
  /** The workspace volume root the session dir lives on (shared mode checks against it). */
  readonly workspaceDir?: string;
}

const sharedDone = new Set<string>();

export async function ensureSessionDir(
  sessionDir: string,
  options: SessionDirOptions = {},
): Promise<void> {
  const shared = options.shared === true;
  await mkdir(sessionDir, { recursive: true, mode: shared ? 0o770 : 0o700 });
  if (!shared || sharedDone.has(sessionDir)) return;
  const root = options.workspaceDir ?? path.dirname(sessionDir);
  for (let dir = sessionDir; dir.startsWith(`${root}/`); dir = path.dirname(dir)) {
    await shareOnVolume(root, dir, 0o2770);
  }
  for (const name of await readdir(sessionDir).catch(() => [] as string[])) {
    if (name.endsWith(".jsonl")) await shareOnVolume(root, path.join(sessionDir, name), 0o660);
  }
  sharedDone.add(sessionDir);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Every entry id in a session file (streamed; files can be large). */
export async function readEntryIds(file: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const splitter = new LineSplitter({
    maxLineBytes: PI_MAX_LINE_BYTES,
    onLine: (line) => {
      try {
        const record = JSON.parse(line) as { id?: unknown; type?: unknown };
        if (record.type !== "session" && typeof record.id === "string") ids.add(record.id);
      } catch {
        // a torn last line; Pi tolerates it too
      }
    },
  });
  for await (const chunk of createReadStream(file)) splitter.push(chunk as Buffer);
  splitter.end();
  return ids;
}

export const BRANCH_CUSTOM_TYPE = "kobe.branch";

export type BranchResult =
  | { readonly ok: true; readonly entryId: string }
  | { readonly ok: false; readonly message: string };

/**
 * Edit-and-regenerate (`run.start.parent_entry_id`). Pi 1.0.0 RPC has no in-place tree navigation
 * (`fork` moves Pi to a NEW session file, verified), but Pi resumes a session at its last appended
 * entry (verified). So, with the thread's Pi stopped, the agent appends a `custom` entry (which
 * never enters model context) whose parent is the branch point; the next prompt continues from it,
 * in the same file, so the thread keeps one entry tree (D15).
 */
export async function appendBranchMarker(
  file: string,
  parentEntryId: string,
  runId: string,
  now: Date = new Date(),
  /** The workspace volume root the file must be on (KOBE-71); unchecked when absent. */
  volume?: string,
): Promise<BranchResult> {
  if (!(await fileExists(file))) return { ok: false, message: "thread has no session file" };
  const ids = await readEntryIds(file);
  if (!ids.has(parentEntryId)) return { ok: false, message: "parent entry not in session" };
  let entryId: string;
  do entryId = randomBytes(4).toString("hex");
  while (ids.has(entryId));
  const marker = {
    type: "custom",
    id: entryId,
    parentId: parentEntryId,
    timestamp: now.toISOString(),
    customType: BRANCH_CUSTOM_TYPE,
    data: { run_id: runId },
  };
  // O_NOFOLLOW: model-run code can write the sessions dir; never append through a symlink, nor
  // to a file off the session dir's volume (a replaced parent, KOBE-71).
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (volume !== undefined) await assertOnVolume(handle, volume, file);
    await handle.write(encodeJsonl(marker));
  } finally {
    await handle.close();
  }
  return { ok: true, entryId };
}

/**
 * Rebuild one thread's session file from `session.restore` parts. Parts stream to a temp file next
 * to the target (bounded memory), and only the final part renames it into place.
 */
export class SessionRestore {
  readonly #target: string;
  readonly #temp: string;
  readonly #maxBytes: number;
  readonly #volume: string | undefined;
  #handle: FileHandle | undefined;
  #nextPart = 0;
  #bytes = 0;
  #entries = 0;

  /** `volume`: the workspace volume root the file must be on (KOBE-71); unchecked when absent. */
  constructor(target: string, maxBytes: number, volume?: string) {
    this.#target = target;
    this.#volume = volume;
    // Unpredictable name, created exclusively and never through a symlink (O_EXCL | O_NOFOLLOW).
    this.#temp = `${target}.restore-${randomBytes(8).toString("hex")}.tmp`;
    this.#maxBytes = maxBytes;
  }

  get nextPart(): number {
    return this.#nextPart;
  }

  async writePart(
    part: number,
    header: PiSessionHeader | undefined,
    entries: readonly PiSessionEntry[],
    fallbackHeader: () => PiSessionHeader,
  ): Promise<number> {
    if (part !== this.#nextPart) throw new Error(`expected part ${this.#nextPart}, got ${part}`);
    if (part > 0 && header !== undefined) throw new Error("header only allowed in part 0");
    if (part === 0) {
      const flags =
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
      // 0660: under Pi identities (KOBE-71) the thread's Pi appends to it through the workspace
      // group; the session dir itself is the agent's and the group's only.
      const handle = await open(this.#temp, flags, 0o660);
      this.#handle = handle;
      if (this.#volume !== undefined) await assertOnVolume(handle, this.#volume, this.#temp);
      await handle.chmod(0o660);
    }
    const records: readonly unknown[] =
      part === 0 ? [header ?? fallbackHeader(), ...entries] : entries;
    const lines = records.map((record) => encodeJsonl(record)).join("");
    const bytes = Buffer.byteLength(lines);
    if (this.#bytes + bytes > this.#maxBytes) throw new Error("restored session too large");
    await this.#handle?.write(lines);
    this.#bytes += bytes;
    this.#entries += entries.length;
    this.#nextPart += 1;
    return this.#entries;
  }

  async commit(): Promise<number> {
    const handle = this.#handle;
    if (handle === undefined) throw new Error("nothing to commit");
    await handle.sync();
    await handle.close();
    this.#handle = undefined;
    await rename(this.#temp, this.#target);
    return this.#entries;
  }

  async abort(): Promise<void> {
    await this.#handle?.close().catch(() => undefined);
    this.#handle = undefined;
    await rm(this.#temp, { force: true });
  }
}
