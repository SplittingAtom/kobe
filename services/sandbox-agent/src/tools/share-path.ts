import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { FILE_SHARE_MAX_BYTES, isExcludedPath, workspacePathIssue } from "@kobe/protocol";

/**
 * Path confinement for `share_file` (KOBE-149). The model names a path; before anything is read or
 * pushed it must name one regular file inside the workspace, reached without any symlink:
 *
 * 1. lexical: relative, or absolute under the workspace root; no `..`, control characters or
 *    backslashes (`workspacePathIssue`); not under `.kobe/` (the agent's own data);
 * 2. physical: `realpath` of the target must equal `realpath(root)/rel` exactly. Any symlink in
 *    any component (to outside, or to elsewhere inside) changes the real path, so it is refused:
 *    nothing is followed. Fail closed on every filesystem error;
 * 3. the target is a regular file (lstat: no FIFO, device, socket, directory) of at most
 *    {@link FILE_SHARE_MAX_BYTES}.
 *
 * This is a check; the push itself (`WorkspaceSync.pushPath`) re-opens the file with
 * `O_NOFOLLOW` and verifies the volume, so a swap after this check is caught there.
 */
export type SharePathCode = "invalid_path" | "not_found" | "too_large";

export class SharePathError extends Error {
  constructor(
    readonly code: SharePathCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedSharePath {
  /** Workspace-relative path (the key in workspace sync). */
  readonly rel: string;
  readonly size: number;
}

function lexicalRel(root: string, input: string): string {
  if (input === "" || /[\u0000-\u001f\u007f\\]/u.test(input)) {
    throw new SharePathError("invalid_path", "the path is empty or has a forbidden character");
  }
  if (input.split("/").includes("..")) {
    throw new SharePathError("invalid_path", "the path must not contain ..");
  }
  let rel = input;
  if (input.startsWith("/")) {
    const prefix = `${root}/`;
    if (!input.startsWith(prefix)) {
      throw new SharePathError("invalid_path", `the path is outside the workspace (${root})`);
    }
    rel = input.slice(prefix.length);
  }
  rel = path.posix.normalize(rel);
  const issue = rel === "." ? "the workspace root" : workspacePathIssue(rel);
  if (issue !== undefined) throw new SharePathError("invalid_path", `invalid path: ${issue}`);
  if (isExcludedPath(rel)) {
    throw new SharePathError("invalid_path", "files under .kobe/ cannot be shared");
  }
  return rel;
}

export async function resolveSharePath(root: string, input: string): Promise<ResolvedSharePath> {
  const rel = lexicalRel(root, input);
  const target = path.join(root, rel);
  let real: string;
  let realRoot: string;
  try {
    realRoot = await realpath(root);
    real = await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SharePathError("not_found", `no such file in the workspace: ${rel}`);
    }
    throw new SharePathError("invalid_path", `cannot resolve ${rel}`);
  }
  if (real !== path.join(realRoot, rel)) {
    throw new SharePathError("invalid_path", "the path goes through a symbolic link");
  }
  let stat;
  try {
    stat = await lstat(target);
  } catch {
    throw new SharePathError("not_found", `no such file in the workspace: ${rel}`);
  }
  if (!stat.isFile()) throw new SharePathError("invalid_path", `${rel} is not a regular file`);
  if (stat.size > FILE_SHARE_MAX_BYTES) {
    throw new SharePathError(
      "too_large",
      `${rel} is ${stat.size} bytes; the limit is ${FILE_SHARE_MAX_BYTES}`,
    );
  }
  return { rel, size: stat.size };
}
