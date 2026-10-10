import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * The one physical path-confinement check of the sandbox agent (KOBE-149 `share_file`, KOBE-144
 * attachments; folded together in KOBE-191). Callers do their own lexical checks and hand over a
 * workspace-relative path; this decides whether the filesystem agrees:
 *
 * - `realpath(target)` (or of its deepest existing ancestor, when `allowMissing` and the file is
 *   not there yet) must equal `realpath(root)/rel` exactly. A symlink in any component, to outside
 *   or elsewhere inside, changes the real path and is refused; a symlink as the last component is
 *   refused even when dangling. Nothing is followed; every filesystem error fails closed.
 * - an existing target is a regular file (lstat: no FIFO, device, socket, directory).
 *
 * It is a check, not a lock: a reader still opens with `O_NOFOLLOW` where a swap matters.
 */
export type ConfineCode = "invalid_path" | "not_found";

export class ConfineError extends Error {
  constructor(
    readonly code: ConfineCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ConfinedFile {
  readonly absolute: string;
  readonly exists: boolean;
  readonly size: number;
}

async function physicalMatches(root: string, realRoot: string, target: string): Promise<boolean> {
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      return real === path.join(realRoot, path.relative(root, probe));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = path.dirname(probe);
      if (parent === probe || !parent.startsWith(root)) return false;
      probe = parent;
    }
  }
}

export async function confineFile(
  root: string,
  rel: string,
  options: { readonly allowMissing: boolean },
): Promise<ConfinedFile> {
  const realRoot = await realpath(root).catch(() => undefined);
  if (realRoot === undefined)
    throw new ConfineError("invalid_path", "workspace root is unavailable");
  const absolute = path.join(root, rel);
  const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => error);
  if (stat instanceof Error) {
    if (stat.code !== "ENOENT" && stat.code !== "ENOTDIR") {
      throw new ConfineError("invalid_path", `cannot resolve ${rel}`);
    }
    if (!options.allowMissing) {
      throw new ConfineError("not_found", `no such file in the workspace: ${rel}`);
    }
    if (!(await physicalMatches(root, realRoot, absolute))) {
      throw new ConfineError("invalid_path", "the path goes through a symbolic link");
    }
    return { absolute, exists: false, size: 0 };
  }
  if (stat.isSymbolicLink()) throw new ConfineError("invalid_path", "the path is a symbolic link");
  if (!(await physicalMatches(root, realRoot, absolute))) {
    throw new ConfineError("invalid_path", "the path goes through a symbolic link");
  }
  if (!stat.isFile()) throw new ConfineError("invalid_path", `${rel} is not a regular file`);
  return { absolute, exists: true, size: stat.size };
}
