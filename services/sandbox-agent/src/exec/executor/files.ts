import { constants as FS } from "node:fs";
import { access, mkdir, open, readdir, stat } from "node:fs/promises";
import { CHUNK_BYTES, type ExecError } from "../../kobe-exec/protocol.js";

/** The executor's file operations. All run as the executor's uid: that is the point. */

/** Most bytes of directory listing in one reply (the reply line limit leaves headroom). */
const MAX_LISTING_BYTES = 1536 * 1024;

export class OperationError extends Error {
  constructor(readonly error: ExecError) {
    super(error.message);
  }
}

/** A Node fs error as the wire error: its errno code survives, so Pi's messages match. */
export function toExecError(error: unknown): ExecError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return { code: typeof code === "string" ? code : "error", message };
}

function notRegular(path: string, isDirectory: boolean): OperationError {
  return isDirectory
    ? new OperationError({
        code: "EISDIR",
        message: `EISDIR: illegal operation on a directory, read`,
      })
    : new OperationError({ code: "EINVAL", message: `not a regular file: ${path}` });
}

export interface ReadChunk {
  readonly data: string;
  readonly size: number;
  readonly eof: boolean;
}

/** `length` bytes at `offset` of a regular file (a FIFO or device is refused, not waited on). */
export async function readChunk(path: string, offset: number, length: number): Promise<ReadChunk> {
  const handle = await open(path, FS.O_RDONLY | FS.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notRegular(path, info.isDirectory());
    const buffer = Buffer.alloc(Math.min(length, CHUNK_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return {
      data: buffer.subarray(0, bytesRead).toString("base64"),
      size: info.size,
      eof: bytesRead < buffer.length,
    };
  } finally {
    await handle.close();
  }
}

/** Create/truncate (first chunk) or append (later chunks) a regular file. */
export async function writeChunk(path: string, data: string, append: boolean): Promise<void> {
  const flags = FS.O_WRONLY | FS.O_CREAT | FS.O_NONBLOCK | (append ? FS.O_APPEND : 0);
  const handle = await open(path, flags, 0o666);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notRegular(path, info.isDirectory());
    // Truncate only once we know it is a regular file we opened (O_TRUNC would hit a device).
    if (!append) await handle.truncate(0);
    await handle.write(Buffer.from(data, "base64"));
  } finally {
    await handle.close();
  }
}

export async function makeDirs(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function checkAccess(path: string, write: boolean): Promise<void> {
  return access(path, write ? FS.R_OK | FS.W_OK : FS.R_OK);
}

export async function statPath(
  path: string,
): Promise<{ kind: "file" | "dir" | "other"; size: number }> {
  const info = await stat(path);
  return { kind: info.isDirectory() ? "dir" : info.isFile() ? "file" : "other", size: info.size };
}

export interface Listing {
  readonly entries: { name: string; dir: boolean | null }[];
  readonly truncated: boolean;
}

/**
 * Entries of a directory, sorted the way Pi's ls sorts them (case-insensitive locale order), with
 * whether each is a directory (symlinks followed; `null` when it cannot be stat'ed, which Pi's ls
 * skips). A huge directory is cut after the first entries that fit one reply.
 */
export async function listDirectory(path: string): Promise<Listing> {
  const names = await readdir(path);
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const entries: { name: string; dir: boolean | null }[] = [];
  let bytes = 0;
  for (const name of names) {
    bytes += Buffer.byteLength(name) + 32;
    if (bytes > MAX_LISTING_BYTES) return { entries, truncated: true };
    const dir = await stat(`${path}/${name}`).then(
      (info) => info.isDirectory(),
      () => null,
    );
    entries.push({ name, dir });
  }
  return { entries, truncated: false };
}
