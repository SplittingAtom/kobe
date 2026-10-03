import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Startup check of the kobe-policy file (KOBE-36): a regular file that only root can change — the
 * file and every directory above it owned by uid 0 and not group/world-writable — as baked into the
 * image (`/opt/kobe/pi-extensions/kobe-policy`, 0444 in 0555 directories). Model-run code runs as
 * the sandbox user, so it must not be able to replace or edit the extension Pi loads. Throws with
 * the reason; the agent then exits non-zero (fail fast). Returns the resolved path: the agent hands
 * that to Pi, so no symlink along the configured path is followed again later.
 */
export async function checkPolicyExtensionFile(file: string): Promise<string> {
  const resolved = await realpath(file).catch(() => {
    throw new Error(`kobe-policy extension not found: ${file}`);
  });
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`kobe-policy extension is not a file: ${file}`);
  for (let current = resolved; ; current = path.dirname(current)) {
    const entry = current === resolved ? info : await stat(current);
    if (entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
      throw new Error(`kobe-policy extension must be root-owned and read-only: ${current}`);
    }
    if (path.dirname(current) === current) return resolved;
  }
}
