import { z } from "zod";
import { matchGlob } from "../glob.js";
import { SHA256_HEX_PATTERN } from "../skill-package/layout.js";

/**
 * What an `outputs` glob matches (KOBE-324, spec SK15): files the execution **produced** under
 * `/workspace`.
 *
 * - **Before** is the case's fixtures, as the runner wrote them into the empty volume: their paths
 *   and SHA-256 come from the package bytes on the server, not from the sandbox.
 * - **After** is taken in the sandbox when the run has ended (a sandbox-wire request carrying the
 *   walk roots and the fixture paths; self-reported, like every sandbox observation; the Registry
 *   re-run is the authoritative one). It walks only each glob's literal directory prefix
 *   ({@link evalOutputWalkRoots}: `outputs/*.xlsx` walks `outputs/`, a glob that starts with a
 *   wildcard walks all of `/workspace`), so an `npm install` or a venv elsewhere costs nothing. Each
 *   walk stops after {@link EVAL_WORKSPACE_MAX_FILES} entries (`truncated`).
 * - The walk uses `lstat` and never follows a symbolic link: a link is recorded as `symlink` and
 *   never read, opened or passed on (`outputs/x.xlsx -> /proc/self/environ` reads nothing). It
 *   records regular files only, and never descends into a reserved path
 *   ({@link isReservedWorkspacePath}: a `skills` or hidden segment at any depth, such as `.kobe/`,
 *   where Pi keeps its session files; so `outputs/skills/x.md` never counts either).
 * - It hashes **only fixture paths**: a path that wasn't a fixture is produced because it is new
 *   (its size comes from `lstat`), so a 4 GiB output is never hashed. A fixture path counts only
 *   when its bytes changed (editing a file in place is a real output); one reported without a hash
 *   doesn't count.
 *
 * A glob is matched as a string against produced paths only, so it can't reach a reserved path or
 * leave `/workspace`, whatever its wildcards. Over a cap the check fails (`over_cap`). Reading a
 * matched file afterwards (for the judge) opens it with `O_NOFOLLOW`, refuses it unless `fstat`
 * shows a regular file of the walked size (a process left running may have swapped it), and reads
 * at most {@link EVAL_OUTPUT_READ_MAX_BYTES}.
 */

/** Entries one walk records at most; more makes the walk `truncated` and its globs fail. */
export const EVAL_WORKSPACE_MAX_FILES = 10_000;
/** Produced files one glob may match, and their bytes in total; more fails the check. */
export const EVAL_OUTPUT_MAX_MATCHES = 100;
export const EVAL_OUTPUT_MAX_BYTES = 50 * 1024 * 1024;
/** Bytes read of one matched file for the judge: 4 per character of the judge's text cap. */
export const EVAL_OUTPUT_READ_MAX_BYTES = 4 * 64 * 1024;

/** A `skills` or hidden (dot) segment, at any depth. */
export function isReservedWorkspacePath(path: string): boolean {
  return path.split("/").some((segment) => segment === "skills" || segment.startsWith("."));
}

/** The literal directory a glob can only match below: `outputs/` for `outputs/*.xlsx`, or `""`. */
export function evalOutputWalkRoot(glob: string): string {
  let literal = "";
  const points = [...glob];
  for (let i = 0; i < points.length; i += 1) {
    const c = points[i] as string;
    if (c === "*" || c === "?") break;
    if (c === "\\") {
      i += 1;
      literal += points[i] ?? "";
    } else literal += c;
  }
  return literal.slice(0, literal.lastIndexOf("/") + 1);
}

/** The directories the after-walk covers for these globs: no root inside another. */
export function evalOutputWalkRoots(globs: readonly string[]): string[] {
  const roots = [...new Set(globs.map(evalOutputWalkRoot))].sort();
  return roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(o)));
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
const sha256 = z.string().regex(SHA256_HEX_PATTERN);

export const evalWorkspaceEntrySchema = z.strictObject({
  path: workspacePath,
  type: z.enum(["file", "symlink", "other"]),
  size: z.number().int().min(0),
  /** Only for a regular file at a fixture path (never for a link: it is never read). */
  sha256: sha256.optional(),
});
export type EvalWorkspaceEntry = z.infer<typeof evalWorkspaceEntrySchema>;

/** One walk of the after-snapshot: everything below `root` (`""` is all of `/workspace`). */
export const evalWorkspaceWalkSchema = z.strictObject({
  root: z.string().max(4096),
  entries: z.array(evalWorkspaceEntrySchema).max(EVAL_WORKSPACE_MAX_FILES),
  truncated: z.boolean(),
});
export type EvalWorkspaceWalk = z.infer<typeof evalWorkspaceWalkSchema>;

export const evalWorkspaceSnapshotSchema = z.strictObject({
  walks: z.array(evalWorkspaceWalkSchema).max(10),
});
export type EvalWorkspaceSnapshot = z.infer<typeof evalWorkspaceSnapshotSchema>;

/** A fixture as the runner wrote it: where it landed and the SHA-256 of its package bytes. */
export interface EvalFixtureFile {
  readonly path: string;
  readonly sha256: string;
}

/** The regular files of a walk that the execution produced (see the module comment). */
export function producedFiles(
  fixtures: readonly EvalFixtureFile[],
  walk: EvalWorkspaceWalk,
): EvalWorkspaceEntry[] {
  const had = new Map(fixtures.map((f) => [f.path, f.sha256] as const));
  return walk.entries.filter((e) => {
    if (e.type !== "file" || !e.path.startsWith(walk.root) || isReservedWorkspacePath(e.path))
      return false;
    const before = had.get(e.path);
    return before === undefined || (e.sha256 !== undefined && e.sha256 !== before);
  });
}

export interface EvalOutputsResult {
  readonly passed: boolean;
  readonly reason?: "not_produced" | "over_cap";
  readonly detail?: string;
  /** Produced files the globs matched, in path order: what the judge may be shown. */
  readonly files: readonly EvalWorkspaceEntry[];
}

const fail = (reason: "not_produced" | "over_cap", detail: string): EvalOutputsResult => ({
  passed: false,
  reason,
  detail,
  files: [],
});

/** The `outputs` check: every glob matches at least one produced file, within the caps. */
export function checkEvalOutputs(
  globs: readonly string[],
  fixtures: readonly EvalFixtureFile[],
  after: EvalWorkspaceSnapshot,
): EvalOutputsResult {
  const matched = new Map<string, EvalWorkspaceEntry>();
  for (const glob of globs) {
    const root = evalOutputWalkRoot(glob);
    const walk = after.walks.find((w) => root.startsWith(w.root));
    if (!walk) return fail("not_produced", `${root || "/workspace"} was not walked`);
    if (walk.truncated)
      return fail(
        "over_cap",
        `${walk.root || "/workspace"} holds more than ${EVAL_WORKSPACE_MAX_FILES} entries`,
      );
    const hits = producedFiles(fixtures, walk).filter((f) => matchGlob(glob, f.path));
    if (hits.length === 0) return fail("not_produced", `no produced file matches ${glob}`);
    const bytes = hits.reduce((n, f) => n + f.size, 0);
    if (hits.length > EVAL_OUTPUT_MAX_MATCHES || bytes > EVAL_OUTPUT_MAX_BYTES)
      return fail(
        "over_cap",
        `${glob} matches more than ${EVAL_OUTPUT_MAX_MATCHES} files or ${EVAL_OUTPUT_MAX_BYTES / 1024 / 1024} MiB`,
      );
    for (const f of hits) matched.set(f.path, f);
  }
  return { passed: true, files: [...matched.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}
