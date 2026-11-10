import { PROJECT_WORKSPACE_DIR, workspaceToolPath } from "@kobe/protocol";
import type { ThreadFileAccess } from "@kobe/db";
import { canonicalPath, SANDBOX_CWD } from "../policy/tool-inputs.js";
import { isInternalPath } from "../workspace-files/paths.js";

/**
 * Which built-in tool calls link a thread to a workspace path (KOBE-610, spec thread-file-map §3,
 * TFM1/TFM2): Pi's file tools, `share_file` (a shared file), `open_file` and `run_python` on a
 * notebook. `bash` and every other tool are never parsed for paths.
 */
export const LINK_TOOLS: Readonly<Record<string, ThreadFileAccess>> = {
  read: "read",
  ls: "read",
  find: "read",
  grep: "read",
  share_file: "read",
  open_file: "read",
  propose_file_edit: "read",
  write: "write",
  edit: "write",
  run_python: "write",
};

/** A tool's path argument as a workspace path (relative to `/workspace`), or undefined. */
export function workspaceRelative(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const absolute = canonicalPath(raw);
  if (absolute === undefined || !absolute.startsWith(`${SANDBOX_CWD}/`)) return undefined;
  const relative = workspaceToolPath(absolute);
  if (relative === undefined || isInternalPath(relative)) return undefined;
  return relative;
}

/** The link a tool call makes: its access and workspace path; undefined for anything else. */
export function toolCallLink(
  tool: string,
  input: unknown,
): { readonly access: ThreadFileAccess; readonly path: string } | undefined {
  const access = Object.hasOwn(LINK_TOOLS, tool) ? LINK_TOOLS[tool] : undefined;
  if (access === undefined || typeof input !== "object" || input === null) return undefined;
  // ls/find/grep without a path mean the whole workspace: no link (the root is not a file).
  const path = workspaceRelative((input as { path?: unknown }).path);
  return path === undefined ? undefined : { access, path };
}

/** `projects/<slug>/<rest>` → slug and path inside the project; undefined outside that area. */
export function projectMountPath(
  path: string,
): { readonly slug: string; readonly inner: string } | undefined {
  const prefix = `${PROJECT_WORKSPACE_DIR}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { slug: rest.slice(0, slash), inner: rest.slice(slash + 1) };
}

/** The workspace-tree path of a project file (as `GET /v1/workspace/files` names it). */
export function projectTreePath(slug: string, inner: string): string {
  return `${PROJECT_WORKSPACE_DIR}/${slug}/${inner}`;
}
