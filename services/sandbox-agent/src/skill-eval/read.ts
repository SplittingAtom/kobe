import { constants as FS, existsSync } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  EVAL_OUTPUT_READ_MAX_BYTES,
  EVAL_READ_MAX_TOTAL_BYTES,
  isReservedWorkspacePath,
  type EvalReadFrame,
  type EvalReadResult,
} from "@kobe/protocol";
import { parentsAreDirs } from "../workspace/fs.js";
import { volumeDevice } from "../workspace/volume.js";

// The matched outputs' bytes for the server's judge (KOBE-326, contract KOBE-324 `outputs.ts`):
// each file opened with O_NOFOLLOW and O_NONBLOCK (a FIFO never blocks the agent), no link on the
// way (every parent an lstat directory; on Linux the open descriptor must name exactly the path),
// refused unless fstat shows a regular file of the walked size with one link on the workspace
// volume (a process left running may have
// swapped or grown it), at most EVAL_OUTPUT_READ_MAX_BYTES each and EVAL_READ_MAX_TOTAL_BYTES in
// all. The request carries paths and sizes only; nothing the judge is told reaches the sandbox.

type ReadEntry = EvalReadResult["files"][number];
type Refusal = Extract<ReadEntry, { status: "refused" }>["reason"];

const PROC_FD = existsSync("/proc/self/fd") ? "/proc/self/fd" : undefined;

class Refused extends Error {
  constructor(readonly reason: Refusal) {
    super(reason);
  }
}

/** Opens `rel` without following any link, or throws {@link Refused}. */
async function openNoFollow(workspace: string, rel: string): Promise<FileHandle> {
  if (isReservedWorkspacePath(rel)) throw new Refused("unreadable");
  if (!(await parentsAreDirs(workspace, rel))) throw new Refused("link");
  const abs = path.join(workspace, rel);
  let handle: FileHandle;
  try {
    handle = await open(abs, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (err) {
    throw new Refused((err as { code?: string }).code === "ELOOP" ? "link" : "unreadable");
  }
  try {
    // A parent swapped for a link between the lstat and the open: the descriptor tells.
    if (PROC_FD && (await readlink(`${PROC_FD}/${handle.fd}`)) !== abs) throw new Refused("link");
    if (!PROC_FD) {
      const [opened, now] = await Promise.all([handle.stat(), lstat(abs)]);
      if (now.isSymbolicLink() || now.ino !== opened.ino || now.dev !== opened.dev)
        throw new Refused("link");
    }
    return handle;
  } catch (err) {
    await handle.close();
    throw err instanceof Refused ? err : new Refused("unreadable");
  }
}

async function readUpTo(handle: FileHandle, max: number): Promise<Buffer> {
  const buffer = Buffer.alloc(max);
  let filled = 0;
  while (filled < max) {
    const { bytesRead } = await handle.read(buffer, filled, max - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** One file: its bytes (up to `cap`), or why not. */
async function readOne(
  workspace: string,
  file: EvalReadFrame["files"][number],
  cap: number,
): Promise<ReadEntry> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(workspace, file.path);
  } catch (err) {
    const reason = err instanceof Refused ? err.reason : "unreadable";
    return { path: file.path, status: "refused", reason };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { path: file.path, status: "refused", reason: "not_regular" };
    // A hard link a tool made to a file only the agent may read (KOBE-326 review L1), or a file
    // on another filesystem: never read for the judge.
    if (stat.nlink !== 1) return { path: file.path, status: "refused", reason: "link" };
    if (stat.dev !== (await volumeDevice(workspace)))
      return { path: file.path, status: "refused", reason: "off_volume" };
    if (stat.size !== file.size)
      return { path: file.path, status: "refused", reason: "size_changed" };
    const bytes = await readUpTo(handle, Math.min(cap, stat.size));
    return {
      path: file.path,
      status: "read",
      data: bytes.toString("base64"),
      truncated: bytes.length < stat.size,
    };
  } catch {
    return { path: file.path, status: "refused", reason: "unreadable" };
  } finally {
    await handle.close();
  }
}

export async function readOutputs(
  workspace: string,
  frame: EvalReadFrame,
): Promise<EvalReadResult> {
  const resolved = path.resolve(workspace);
  let left = EVAL_READ_MAX_TOTAL_BYTES;
  const files: ReadEntry[] = [];
  for (const file of frame.files) {
    if (left <= 0) {
      files.push({ path: file.path, status: "skipped" });
      continue;
    }
    const entry = await readOne(resolved, file, Math.min(EVAL_OUTPUT_READ_MAX_BYTES, left));
    if (entry.status === "read") left -= Buffer.byteLength(entry.data, "base64");
    files.push(entry);
  }
  return { files };
}
