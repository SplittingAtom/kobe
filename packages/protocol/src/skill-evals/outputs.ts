import { z } from "zod";
import { matchGlob } from "../glob.js";
import { SHA256_HEX_PATTERN } from "../skill-package/layout.js";

/**
 * What an `outputs` glob matches (KOBE-324, spec SK15): files the execution **produced** under
 * `/workspace`, decided by comparing two snapshots the runner takes inside the case's sandbox:
 *
 * 1. **before**: after the fixtures are copied in, before the run starts;
 * 2. **after**: when the run has ended.
 *
 * The walk (both snapshots) uses `lstat` and never follows a symbolic link: a link is recorded as
 * `symlink` and never read, opened or passed on (`outputs/x.xlsx -> /proc/self/environ` reads
 * nothing). It records regular files only, never descends into a reserved path
 * ({@link isReservedWorkspacePath}: `skills/` and hidden folders such as `.kobe/`, where Pi keeps
 * its session files), and stops after {@link EVAL_WORKSPACE_MAX_FILES} entries (`truncated`).
 *
 * A file is produced when it is a regular file in `after`, outside every reserved path, and absent
 * from `before` or with other bytes (SHA-256) than it had there. So a fixture copied into
 * `outputs/` never counts unless the run changed it (editing a file in place is a real output).
 * A glob is matched as a string against those relative paths only, so it can't reach a reserved
 * path or leave `/workspace`, whatever its wildcards. Over a cap the check fails (`over_cap`).
 */

/** Entries one snapshot walks at most; more makes the snapshot `truncated` and `outputs` fail. */
export const EVAL_WORKSPACE_MAX_FILES = 10_000;
/** Produced files one glob may match, and their bytes in total; more fails the check. */
export const EVAL_OUTPUT_MAX_MATCHES = 100;
export const EVAL_OUTPUT_MAX_BYTES = 50 * 1024 * 1024;

/** `skills/` and any hidden (dot) segment, at any depth. */
export function isReservedWorkspacePath(path: string): boolean {
  return path.split("/").some((segment) => segment === "skills" || segment.startsWith("."));
}

const workspacePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\0") &&
      !p.split("/").some((s) => s === ".." || s === "." || s === ""),
    "a path relative to /workspace",
  );

export const evalWorkspaceEntrySchema = z.strictObject({
  path: workspacePath,
  type: z.enum(["file", "symlink", "other"]),
  size: z.number().int().min(0),
  /** Of the file's bytes; empty for a link or another kind of entry (never read). */
  sha256: z.union([z.string().regex(SHA256_HEX_PATTERN), z.literal("")]),
});
export type EvalWorkspaceEntry = z.infer<typeof evalWorkspaceEntrySchema>;

export const evalWorkspaceSnapshotSchema = z.strictObject({
  entries: z.array(evalWorkspaceEntrySchema).max(EVAL_WORKSPACE_MAX_FILES),
  truncated: z.boolean(),
});
export type EvalWorkspaceSnapshot = z.infer<typeof evalWorkspaceSnapshotSchema>;

/** The regular files `after` holds that the execution produced (see the module comment). */
export function producedFiles(
  before: EvalWorkspaceSnapshot,
  after: EvalWorkspaceSnapshot,
): EvalWorkspaceEntry[] {
  const had = new Map(
    before.entries.filter((e) => e.type === "file").map((e) => [e.path, e.sha256] as const),
  );
  return after.entries.filter(
    (e) => e.type === "file" && !isReservedWorkspacePath(e.path) && had.get(e.path) !== e.sha256,
  );
}

export interface EvalOutputsResult {
  readonly passed: boolean;
  readonly reason?: "not_produced" | "over_cap";
  readonly detail?: string;
  /** Produced files the globs matched, in path order: what the judge may be shown. */
  readonly files: readonly EvalWorkspaceEntry[];
}

/** The `outputs` check: every glob matches at least one produced file, within the caps. */
export function checkEvalOutputs(
  globs: readonly string[],
  before: EvalWorkspaceSnapshot,
  after: EvalWorkspaceSnapshot,
): EvalOutputsResult {
  if (before.truncated || after.truncated)
    return {
      passed: false,
      reason: "over_cap",
      detail: `the workspace holds more than ${EVAL_WORKSPACE_MAX_FILES} entries`,
      files: [],
    };
  const produced = producedFiles(before, after);
  const matched = new Map<string, EvalWorkspaceEntry>();
  for (const glob of globs) {
    const hits = produced.filter((f) => matchGlob(glob, f.path));
    if (hits.length === 0)
      return {
        passed: false,
        reason: "not_produced",
        detail: `no produced file matches ${glob}`,
        files: [],
      };
    const bytes = hits.reduce((n, f) => n + f.size, 0);
    if (hits.length > EVAL_OUTPUT_MAX_MATCHES || bytes > EVAL_OUTPUT_MAX_BYTES)
      return {
        passed: false,
        reason: "over_cap",
        detail: `${glob} matches more than ${EVAL_OUTPUT_MAX_MATCHES} files or ${EVAL_OUTPUT_MAX_BYTES / 1024 / 1024} MiB`,
        files: [],
      };
    for (const f of hits) matched.set(f.path, f);
  }
  return { passed: true, files: [...matched.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}
