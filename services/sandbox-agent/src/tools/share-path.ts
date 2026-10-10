import path from "node:path";
import { FILE_SHARE_MAX_BYTES, isExcludedPath, workspacePathIssue } from "@kobe/protocol";
import { confineFile, ConfineError } from "../workspace-confine.js";

/**
 * Path confinement for `share_file` (KOBE-149). The model names a path; before anything is read or
 * pushed it must name one regular file inside the workspace, reached without any symlink:
 *
 * 1. lexical: relative, or absolute under the workspace root; no `..`, control characters or
 *    backslashes (`workspacePathIssue`); not under `.kobe/` (the agent's own data);
 * 2. physical: the shared `workspace-confine.ts` check (no symlink in any component, a regular
 *    file; fail closed on every filesystem error);
 * 3. the target is at most {@link FILE_SHARE_MAX_BYTES}.
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
  // eslint-disable-next-line no-control-regex
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
  let file;
  try {
    file = await confineFile(root, rel, { allowMissing: false });
  } catch (error) {
    if (error instanceof ConfineError) throw new SharePathError(error.code, error.message);
    throw error;
  }
  if (file.size > FILE_SHARE_MAX_BYTES) {
    throw new SharePathError(
      "too_large",
      `${rel} is ${file.size} bytes; the limit is ${FILE_SHARE_MAX_BYTES}`,
    );
  }
  return { rel, size: file.size };
}
