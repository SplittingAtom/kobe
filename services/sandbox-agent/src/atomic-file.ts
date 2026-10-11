import { randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

/**
 * The agent's atomic file writes (temp file + rename), shared by every writer in the agent that
 * puts a file where Pi or its tools can see the directory (KOBE-235, from the #213 review).
 *
 * The temp file is opened `O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK` under a random name, and
 * the open handle is checked to be a regular file before anything is written:
 * - `O_EXCL` fails on anything already there (a symlink, a FIFO, a file), so nothing planted is
 *   ever written through or adopted;
 * - `O_NOFOLLOW` never follows a final symlink;
 * - `O_NONBLOCK` means a FIFO could never stall the open (a FIFO without a reader blocks `open`);
 * - the random name means a tool that lists the directory cannot pre-plant the next temp path.
 * A tool that plants entries at a fixed temp path such as `mcp-token.tmp` therefore costs the agent
 * nothing: the writer never looks there.
 */

const TEMP_SUFFIX = /^\.[0-9a-f]{16}\.tmp$/;

/** `<final>.<16 hex>.tmp`: unpredictable, in the same directory so the rename is atomic. */
export function tempPathFor(final: string): string {
  return `${final}.${randomBytes(8).toString("hex")}.tmp`;
}

/** Whether `name` is a temp file of this module for `base` (so the tripwire may expect it). */
export function isTempOf(base: string, name: string): boolean {
  return name.startsWith(base) && TEMP_SUFFIX.test(name.slice(base.length));
}

/**
 * Create `temp` exclusively and return its handle, with the mode set exactly (the umask filters
 * `open`'s mode). Refuses (and removes what it created) when the result is not a regular file.
 */
export async function openAgentTemp(temp: string, mode: number): Promise<FileHandle> {
  const handle = await open(
    temp,
    FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | FS.O_NONBLOCK,
    mode,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${temp} is not a regular file`);
    await handle.chmod(mode);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return handle;
}

/** Write `text` to `final` atomically with exactly `mode`. */
export async function writeFileAtomic(
  final: string,
  text: string | Uint8Array,
  mode: number,
): Promise<void> {
  const temp = tempPathFor(final);
  const handle = await openAgentTemp(temp, mode);
  try {
    await handle.writeFile(text);
    await handle.close();
    await rename(temp, final);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
