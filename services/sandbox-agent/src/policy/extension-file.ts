import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Startup check of a Kobe Pi extension file (kobe-policy, KOBE-36; kobe-models, KOBE-41): a
 * regular file that only root can change — the file and every directory above it owned by uid 0
 * and not group/world-writable — as baked into the image (`/opt/kobe/pi-extensions/<name>`, 0444
 * in 0555 directories). Model-run code runs as the sandbox user, so it must not be able to replace
 * or edit an extension Pi loads. Throws with the reason; the agent then exits non-zero (fail
 * fast). Returns the resolved path: the agent hands that to Pi, so no symlink along the configured
 * path is followed again later.
 */
export async function checkExtensionFile(file: string, name: string): Promise<string> {
  const resolved = await realpath(file).catch(() => {
    throw new Error(`${name} extension not found: ${file}`);
  });
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`${name} extension is not a file: ${file}`);
  for (let current = resolved; ; current = path.dirname(current)) {
    const entry = current === resolved ? info : await stat(current);
    if (entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
      throw new Error(`${name} extension must be root-owned and read-only: ${current}`);
    }
    if (path.dirname(current) === current) return resolved;
  }
}

export function checkPolicyExtensionFile(file: string): Promise<string> {
  return checkExtensionFile(file, "kobe-policy");
}
