import {
  isMemberDropPath,
  mentionPathIssue,
  WORKSPACE_EXCLUDED_PREFIXES,
  WORKSPACE_SEGMENT_MAX_BYTES,
  WORKSPACE_SERVER_OWNED_PREFIXES,
  type WorkspaceArea,
} from "@kobe/protocol";

/**
 * Path rules of the workspace file browser (KOBE-148). Paths are relative to `/workspace` and are
 * only ever matched against manifest rows (`workspace_files`); they never reach a filesystem or
 * an object key (keys are derived from content hashes, workspace-sync/keys.ts).
 */

/** The area a path (file or folder) belongs to: `uploads/` and `projects/` are server-owned. */
export function areaOf(path: string): WorkspaceArea {
  for (const prefix of WORKSPACE_SERVER_OWNED_PREFIXES) {
    if (path === prefix.slice(0, -1) || path.startsWith(prefix)) {
      return prefix === "uploads/" ? "uploads" : "projects";
    }
  }
  return "workspace";
}

/**
 * Read-only in the browser: the server-owned areas (project mounts, thread uploads), except a
 * member's own drop directly in uploads/ (KOBE-199), which they may add and delete.
 */
export function isReadOnlyPath(path: string): boolean {
  return areaOf(path) !== "workspace" && !isMemberDropPath(path);
}

/** Agent-internal paths that are never synced and never browsable. */
export function isInternalPath(path: string): boolean {
  return WORKSPACE_EXCLUDED_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

/** Every proper ancestor folder of `path`: `a/b/c` -> `a`, `a/b`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `LIKE` pattern matching everything under `folder/` ("" = everything). */
export function underPattern(folder: string): string {
  const prefix = folder === "" ? "" : `${folder}/`;
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * `Content-Disposition` for a download: always `attachment`, a plain ASCII fallback name and the
 * RFC 5987 UTF-8 name. Quotes, backslashes, semicolons and non-ASCII never reach the plain one.
 */
export function attachmentDisposition(path: string): string {
  const name = baseName(path);
  const fallback = name.replace(/[^\x20-\x7e]|["\\;%]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const ENCODER = new TextEncoder();
const bytes = (s: string) => ENCODER.encode(s).length;

/**
 * The `n`th copy of a file's path after a name clash: `dir/report (1).pdf`. A name over the
 * segment limit loses characters from its stem, never its extension (an extension too long to
 * keep is treated as part of the stem).
 */
export function copyPath(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const suffix = ` (${n})`;
  const dot = name.lastIndexOf(".");
  let ext = dot > 0 ? name.slice(dot) : "";
  if (bytes(suffix + ext) > WORKSPACE_SEGMENT_MAX_BYTES) ext = "";
  const stem = [...name.slice(0, name.length - ext.length)];
  while (stem.length > 0 && bytes(stem.join("") + suffix + ext) > WORKSPACE_SEGMENT_MAX_BYTES) {
    stem.pop();
  }
  return `${dir}${stem.join("")}${suffix}${ext}`;
}

export interface MoveRefusal {
  readonly status: 400 | 403 | 404;
  readonly code: "invalid_path" | "read_only" | "not_found";
  readonly message: string;
}

/**
 * Why `from` may not move to `to` (KOBE-304), or undefined: the path rules both already passed
 * (`workspacePathSchema`) plus the mention rules for the new path (KOBE-223: no invisible,
 * format, default-ignorable or shell characters), never agent-internal (`.kobe/` stays hidden:
 * not found), never read-only on either side (project mounts, thread uploads; a member's drop
 * may move, and a file may become one), and never onto itself or into itself.
 */
export function moveRefusal(from: string, to: string): MoveRefusal | undefined {
  if (isInternalPath(from))
    return { status: 404, code: "not_found", message: "No such file or folder." };
  if (isInternalPath(to) || mentionPathIssue(to) !== undefined) {
    return {
      status: 400,
      code: "invalid_path",
      message:
        "That name can't be used: names may not hold invisible, control or format characters, " +
        "`, $ or ;, or spaces other than the plain space.",
    };
  }
  if (from === to) {
    return { status: 400, code: "invalid_path", message: "It is already there." };
  }
  if (to.startsWith(`${from}/`)) {
    return { status: 400, code: "invalid_path", message: "A folder can't move into itself." };
  }
  if (isReadOnlyPath(from) || isReadOnlyPath(to)) {
    return {
      status: 403,
      code: "read_only",
      message: "Project files and thread uploads are read-only here.",
    };
  }
  return undefined;
}
