import {
  WORKSPACE_EXCLUDED_PREFIXES,
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

/** Read-only in the browser: the server-owned areas (project mounts, thread uploads). */
export function isReadOnlyPath(path: string): boolean {
  return areaOf(path) !== "workspace";
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
