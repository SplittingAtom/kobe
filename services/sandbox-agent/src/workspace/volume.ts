import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";

/**
 * The agent writes and reads files under /workspace, where every thread's tools can rename
 * directories (D13: the workspace is shared and writable). A tool can therefore swap a parent
 * directory for a symlink between the agent's checks and its open, and point the agent at a file
 * elsewhere that only the agent may touch: another Pi's runtime directory, the bootstrap token
 * (KOBE-71 confused-deputy guard). Those all live on other filesystems (/tmp, the projected token
 * mount), so after every open the agent checks the file is on the workspace volume itself.
 * Renames then stay on that volume too: a rename never crosses filesystems, and its source is a
 * file just verified to be there.
 */
const devices = new Map<string, Promise<number>>();

/**
 * Device of a volume root, read once per process. The root itself (a mount point such as
 * /workspace) cannot be replaced by sandbox code; only what is under it can.
 */
export function volumeDevice(root: string): Promise<number> {
  let device = devices.get(root);
  if (device === undefined) {
    device = stat(root).then((info) => info.dev);
    devices.set(root, device);
    device.catch(() => devices.delete(root));
  }
  return device;
}

export class OffVolumeError extends Error {
  constructor(file: string) {
    super(`${file} is not on the workspace volume (a parent directory was replaced)`);
    this.name = "OffVolumeError";
  }
}

/** Throws unless the open file is on `root`'s volume. */
export async function assertOnVolume(
  handle: FileHandle,
  root: string,
  file: string,
): Promise<void> {
  const [info, device] = await Promise.all([handle.stat(), volumeDevice(root)]);
  if (info.dev !== device) throw new OffVolumeError(file);
}

/**
 * Open `file` (never through a final symlink, never blocking on a FIFO) and check it is on
 * `root`'s volume; closes it again on failure.
 */
export async function openOnVolume(
  root: string,
  file: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  const handle = await open(file, flags | constants.O_NOFOLLOW, mode);
  try {
    await assertOnVolume(handle, root, file);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

/**
 * Give a directory or file the agent owns on the workspace volume the shared-group mode `mode`
 * (Pi identities reach the workspace through its group, KOBE-71). Through a handle: a swapped
 * path changes nothing off the volume. Not the agent's own, or not there: left alone.
 */
export async function shareOnVolume(root: string, file: string, mode: number): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await openOnVolume(root, file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return;
  }
  try {
    const info = await handle.stat();
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return;
    if (!info.isDirectory() && !info.isFile()) return;
    if ((info.mode & 0o7777) !== mode) await handle.chmod(mode);
  } catch {
    // best effort: the file is still usable by the agent; a Pi identity may not write it
  } finally {
    await handle.close();
  }
}
