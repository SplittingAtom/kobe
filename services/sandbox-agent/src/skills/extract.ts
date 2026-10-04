import { constants as FS } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { BundleFile } from "./bundle.js";

/**
 * Directories 0755 and files 0644, owned by the agent: a Pi identity (another uid and group, KOBE-71)
 * can read and traverse a skill but never write, rename or delete anything in it. The agent runs
 * with umask 077, so the modes are set explicitly, never inherited.
 */
export const SKILL_DIR_MODE = 0o755;
export const SKILL_FILE_MODE = 0o644;

/**
 * Writes `files` (already validated by `readBundle`) under `dest`, which must be a fresh directory
 * only the agent can write. Belt and braces on top of the validation: every target is re-resolved
 * under `dest`, files are created exclusively (`O_EXCL`, never following a link).
 */
export async function extractFiles(dest: string, files: readonly BundleFile[]): Promise<void> {
  const root = path.resolve(dest);
  await chmod(root, SKILL_DIR_MODE);
  const made = new Set<string>([root]);
  for (const file of files) {
    const target = path.resolve(root, file.path);
    if (!target.startsWith(root + path.sep)) throw new Error("bundle path escapes its directory");
    await ensureDirs(path.dirname(target), root, made);
    const handle = await open(
      target,
      FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW,
      SKILL_FILE_MODE,
    );
    try {
      await handle.writeFile(file.data);
      await handle.chmod(SKILL_FILE_MODE);
    } finally {
      await handle.close();
    }
  }
}

async function ensureDirs(dir: string, root: string, made: Set<string>): Promise<void> {
  if (made.has(dir)) return;
  await ensureDirs(path.dirname(dir), root, made);
  // Not recursive: a directory that already exists here is a bug (paths are validated unique).
  await mkdir(dir, { mode: SKILL_DIR_MODE });
  await chmod(dir, SKILL_DIR_MODE);
  made.add(dir);
}
