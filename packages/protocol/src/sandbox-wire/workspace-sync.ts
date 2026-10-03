import { z } from "zod";

/**
 * Workspace sync contract (KOBE-27, spec D12, D13, D15, D23, D26): `/workspace` ↔ S3 through the
 * server. Consumers: kobe-sandbox-agent (client), the server's sandbox listener (endpoints), and
 * the server-side writers KOBE-53 (uploads), KOBE-54 (file browser), KOBE-57 (project files).
 *
 * Transport and trust
 * - Plain HTTP on the server's **sandbox listener** (the port the team NetworkPolicy already
 *   allows; never the user API), under {@link WORKSPACE_SYNC_PATH}. Auth: the sandbox's
 *   `kobe.sandbox-wire` session token in `Authorization: Bearer` (the audience names the sandbox
 *   listener; these endpoints are on the same listener as `/v1/sandbox/connect`). The server derives
 *   (team, user, sandbox) from the token and checks liveness, account and membership like the wire.
 * - **Sandboxes never hold object-store credentials, URLs or keys.** The server streams bytes
 *   between the sandbox and S3; object keys are derived server-side from the verified token and a
 *   content hash, never from anything the sandbox names.
 *
 * Model
 * - The manifest (Postgres, one row per workspace path per (team, user)) is the record of what is
 *   in S3; every change gets the next revision (`rev`) of that workspace. Deletions are kept as
 *   tombstones for a while so incremental pulls (`since`) see them.
 * - Content is addressed by SHA-256: the sandbox uploads a blob once (`PUT blobs/<sha256>`, the
 *   server verifies the hash while streaming), then commits paths that point at it.
 * - Areas: `uploads/` and `projects/` are **server-owned** (written only by the server: KOBE-53
 *   uploads, KOBE-57 project mounts; read-only to the agent, never accepted in a commit); `.kobe/`
 *   is agent-internal and never synced (Pi session files are rebuilt from Postgres, D15).
 *   Everything else is sandbox-owned: the live volume is authoritative and S3 is its durable copy.
 *
 * Consistency (normative)
 * - A commit change carries `base_rev`: the revision the sandbox's copy was based on (null for a
 *   path it has never seen). The server applies it only if the path's current revision equals
 *   `base_rev` (or the path has no live row and `base_rev` is null or the tombstone's revision);
 *   otherwise the change is a `conflict` and the current row is returned.
 * - Conflict rule (agent): a newer server-written version keeps the path; the sandbox's edit is
 *   preserved as a sibling conflict copy (`<name>.conflict-<timestamp><ext>`) and committed as a
 *   new path. A deletion never beats a modification (a conflicting delete is dropped; a
 *   modification of a path deleted meanwhile is re-committed on top of the tombstone).
 */
export const WORKSPACE_SYNC_PATH = "/v1/sandbox/workspace";

/** Areas only the server writes (read-only to the agent). Trailing slash included. */
export const WORKSPACE_SERVER_OWNED_PREFIXES = ["uploads/", "projects/"] as const;
/** Agent-internal; never synced (session JSONL is rebuilt from Postgres). */
export const WORKSPACE_EXCLUDED_PREFIXES = [".kobe/"] as const;

export const WORKSPACE_PATH_MAX_BYTES = 1024;
export const WORKSPACE_SEGMENT_MAX_BYTES = 255;
/** Most entries per manifest page, hashes per `blobs/missing` call and changes per commit. */
export const WORKSPACE_MAX_BATCH = 1000;

const ENCODER = new TextEncoder();
const utf8Bytes = (s: string): number => ENCODER.encode(s).length;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;
// Bidi embedding/override/isolate controls, LRM/RLM/ALM and the BOM: they make a name display as
// another. Other format characters (ZWJ/ZWNJ in Persian, Indic and emoji names) stay allowed.
const SPOOFING = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\ufeff]/u;

/**
 * A workspace path: relative to `/workspace`, POSIX separators, NFC-agnostic bytes as written by
 * the sandbox. No leading `/`, no empty, `.` or `..` segments, no control or format characters
 * (bidi controls, BOM) or backslashes, at most {@link WORKSPACE_PATH_MAX_BYTES} UTF-8 bytes and
 * {@link WORKSPACE_SEGMENT_MAX_BYTES} per segment. Never an object key (keys are derived from hashes).
 */
export function workspacePathIssue(path: string): string | undefined {
  if (path.length === 0) return "empty";
  if (utf8Bytes(path) > WORKSPACE_PATH_MAX_BYTES) return "too long";
  if (CONTROL.test(path) || path.includes("\\")) return "control character or backslash";
  // Bidirectional controls make a name display as another (see SPOOFING).
  if (SPOOFING.test(path)) return "bidirectional control or BOM";
  if (path.startsWith("/")) return "absolute";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "empty, . or .. segment";
    if (utf8Bytes(segment) > WORKSPACE_SEGMENT_MAX_BYTES) return "segment too long";
  }
  return undefined;
}

export const workspacePathSchema = z.string().superRefine((path, ctx) => {
  const issue = workspacePathIssue(path);
  if (issue !== undefined) ctx.addIssue({ code: "custom", message: `workspace path: ${issue}` });
});

export const isServerOwnedPath = (path: string): boolean =>
  WORKSPACE_SERVER_OWNED_PREFIXES.some((p) => path.startsWith(p));
export const isExcludedPath = (path: string): boolean =>
  WORKSPACE_EXCLUDED_PREFIXES.some((p) => path.startsWith(p) || `${path}/` === p);

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256");
const rev = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

export const workspaceOriginSchema = z.enum(["sandbox", "server"]);
export type WorkspaceOrigin = z.infer<typeof workspaceOriginSchema>;

/** A manifest row. A tombstone (`deleted`) keeps the deleted version's size and mtime. */
export const workspaceEntrySchema = z.strictObject({
  path: workspacePathSchema,
  rev: z.number().int().positive(),
  deleted: z.boolean(),
  /** Absent for tombstones. */
  sha256: sha256HexSchema.optional(),
  size: count,
  mtime_ms: count,
  executable: z.boolean(),
  origin: workspaceOriginSchema,
  /** When the server recorded this revision (epoch ms). */
  updated_ms: count,
});
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

/**
 * `GET manifest?since=<rev>&limit=<n>`: entries with `rev > since` in revision order (tombstones
 * included). `more` → ask again with `since` = the last entry's rev. 409 `resync_required` when
 * `since` is older than the tombstone horizon: pull again from 0.
 */
export const workspaceManifestPageSchema = z.strictObject({
  head_rev: rev,
  entries: z.array(workspaceEntrySchema).max(WORKSPACE_MAX_BATCH),
  more: z.boolean(),
});
export type WorkspaceManifestPage = z.infer<typeof workspaceManifestPageSchema>;

/** `POST blobs/missing`: which of these hashes the server does not hold for this workspace. */
export const workspaceBlobsMissingRequestSchema = z.strictObject({
  sha256: z.array(sha256HexSchema).max(WORKSPACE_MAX_BATCH),
});
export const workspaceBlobsMissingResponseSchema = z.strictObject({
  missing: z.array(sha256HexSchema).max(WORKSPACE_MAX_BATCH),
});

/**
 * `PUT blobs/<sha256>` with the raw bytes and an exact `Content-Length`. 201 stored, 200 already
 * held. 413 `file_too_large`, 507 `quota_exceeded`, 422 `hash_mismatch` (the bytes did not hash to
 * the name: nothing is stored).
 */
export const workspaceBlobPutResponseSchema = z.strictObject({
  sha256: sha256HexSchema,
  size: count,
});

export const workspaceChangeSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("put"),
    path: workspacePathSchema,
    base_rev: rev.nullable(),
    sha256: sha256HexSchema,
    size: count,
    mtime_ms: count,
    executable: z.boolean(),
  }),
  z.strictObject({ op: z.literal("delete"), path: workspacePathSchema, base_rev: rev.nullable() }),
]);
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;

/** `POST commit`: changes applied one by one, each with its own result (no all-or-nothing). */
export const workspaceCommitRequestSchema = z.strictObject({
  changes: z.array(workspaceChangeSchema).min(1).max(WORKSPACE_MAX_BATCH),
});

export const WORKSPACE_REJECT_CODES = [
  "read_only", // server-owned or excluded area
  "missing_blob", // put before the blob was uploaded (or after it was collected): upload again
  "size_mismatch", // put's size differs from the uploaded blob
  "quota_exceeded",
  "too_many_files",
  "invalid_path",
] as const;

export const workspaceChangeResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("applied"), path: z.string(), entry: workspaceEntrySchema }),
  z.strictObject({
    status: z.literal("conflict"),
    path: z.string(),
    /** The current row (live or tombstone); absent when the path has no row at all. */
    current: workspaceEntrySchema.optional(),
  }),
  z.strictObject({
    status: z.literal("rejected"),
    path: z.string(),
    code: z.enum(WORKSPACE_REJECT_CODES),
  }),
  /** A delete of a path with no live row: nothing to do. */
  z.strictObject({ status: z.literal("noop"), path: z.string() }),
]);
export type WorkspaceChangeResult = z.infer<typeof workspaceChangeResultSchema>;

export const workspaceCommitResponseSchema = z.strictObject({
  head_rev: rev,
  results: z.array(workspaceChangeResultSchema).max(WORKSPACE_MAX_BATCH),
});

/**
 * `GET file?path=<path>`: the current content of a live path, `Content-Length` = size, header
 * {@link WORKSPACE_ENTRY_HEADER} = base64url(JSON of its {@link WorkspaceEntry}) (paths are UTF-8,
 * headers are not). 404 `not_found` when the path has no live row.
 */
export const WORKSPACE_ENTRY_HEADER = "x-kobe-workspace-entry";

export function encodeWorkspaceEntryHeader(entry: WorkspaceEntry): string {
  const bytes = ENCODER.encode(JSON.stringify(entry));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Undefined when the header is missing or not a valid entry. */
export function decodeWorkspaceEntryHeader(
  value: string | null | undefined,
): WorkspaceEntry | undefined {
  if (!value || value.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed = workspaceEntrySchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `POST restore-report`: what a restore did (observability; a `full` restore onto an empty volume
 * is audited `workspace.restored`). Counts are the sandbox's own report.
 */
export const workspaceRestoreReportSchema = z.strictObject({
  mode: z.enum(["full", "incremental"]),
  files: count,
  bytes: count,
  duration_ms: count,
});
export type WorkspaceRestoreReport = z.infer<typeof workspaceRestoreReportSchema>;

/** Error body of every non-2xx answer. */
export const workspaceErrorSchema = z.strictObject({ code: z.string(), message: z.string() });
