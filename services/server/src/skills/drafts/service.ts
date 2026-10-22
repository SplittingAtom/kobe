import type { SkillImportOrigin } from "@kobe/protocol";
import { withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { parseSkillMd } from "../skill-md.js";
import { DRAFT_LIMITS, SKILL_MD_PATH, draftPathProblem, skeletonSkillMd } from "./files.js";
import {
  bumpRevision,
  changedBy,
  detachSynced,
  markSynced,
  countOwnDrafts,
  deleteDraft,
  fileInfos,
  insertDraft,
  putFile,
  removeFile,
  visibleDraft,
  type DraftRecord,
  type DraftViewer,
} from "./records.js";
import type { SkillDraftStart } from "@kobe/db";

/**
 * Draft operations (KOBE-320, SK11). Each change runs in one team transaction holding the draft's
 * row lock, checks the caller's revision (`If-Match`) against the draft's and refuses a stale one
 * with who changed it last, then writes and moves the draft to its next revision.
 */

export interface DraftContext {
  readonly db: KobeDb;
  readonly teamId: string;
  readonly viewer: DraftViewer;
}

export type DraftFailure =
  | { readonly error: "not_found" }
  | { readonly error: "forbidden"; readonly message: string }
  | {
      readonly error: "stale_revision";
      readonly rev: number;
      readonly changedBy: { readonly id: string; readonly name: string };
    }
  | { readonly error: "invalid_path"; readonly message: string }
  /** Another draft its conversation saves into already has the name (KOBE-442). */
  | { readonly error: "name_taken"; readonly message: string }
  /** The tool may not write into it: shared, or edited since the conversation's last save. */
  | { readonly error: "not_sync_target"; readonly because: "shared" | "edited" }
  | { readonly error: "too_many_files" | "draft_limit" }
  | { readonly error: "draft_too_large" | "file_too_large"; readonly message: string };

export type DraftOutcome<T> = ({ readonly ok: true } & T) | ({ readonly ok: false } & DraftFailure);

const fail = (failure: DraftFailure): { ok: false } & DraftFailure => ({ ok: false, ...failure });

/** Locks a draft the viewer may edit and checks their revision; the failure otherwise. */
async function lockedAt(
  tx: KobeTx,
  ctx: DraftContext,
  id: string,
  rev: number,
): Promise<DraftRecord | DraftFailure> {
  const draft = await visibleDraft(tx, ctx.teamId, id, ctx.viewer, true);
  if (!draft) return { error: "not_found" };
  if (draft.rev !== rev)
    return {
      error: "stale_revision",
      rev: draft.rev,
      changedBy: await changedBy(tx, draft.updatedBy),
    };
  return draft;
}

const isFailure = (value: DraftRecord | DraftFailure): value is DraftFailure => "error" in value;

/** How a draft starts (KOBE-322, SK10): its provenance and first files. */
export interface DraftStartInput {
  readonly name: string;
  readonly startedFrom: SkillDraftStart;
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** A fork's parent: from the version actually copied, never from the request. */
  readonly parentRef?: Record<string, unknown>;
  /** A start from a conversation: a thread of this team. */
  readonly fromThreadId?: string;
  /** A governed import (KOBE-344): where the files came from, as the server fetched them. */
  readonly origin?: SkillImportOrigin;
  /** Made by the agent's `save_skill_draft` (KOBE-442), recorded in the audit event. */
  readonly via?: "tool";
  /** The tool call that made it, for the audit event (KOBE-442 review L3). */
  readonly toolCall?: ToolCallRef;
  /** The conversation's earlier draft of the name, no longer saved into (KOBE-442 review M2). */
  readonly detach?: string;
}

/** The agent's call behind a save (audit only). */
export interface ToolCallRef {
  readonly runId: string;
  readonly toolCallId: string;
}

/** Why the files can't start a draft (the draft's own limits and path rules), or null. */
export function startFilesProblem(files: ReadonlyMap<string, Uint8Array>): DraftFailure | null {
  if (files.size > DRAFT_LIMITS.maxFiles) return { error: "too_many_files" };
  let total = 0;
  const paths = [...files.keys()];
  for (const [path, bytes] of files) {
    const problem = draftPathProblem(path, paths);
    if (problem) return { error: "invalid_path", message: `${path}: ${problem}.` };
    if (path === SKILL_MD_PATH && bytes.length > DRAFT_LIMITS.maxSkillMdBytes)
      return {
        error: "file_too_large",
        message: `SKILL.md may be at most ${DRAFT_LIMITS.maxSkillMdBytes} bytes.`,
      };
    total += bytes.length;
  }
  if (total > DRAFT_LIMITS.maxDraftBytes)
    return {
      error: "draft_too_large",
      message: `A draft may hold at most ${DRAFT_LIMITS.maxDraftBytes} bytes in all.`,
    };
  return null;
}

const PARENT_KINDS = ["team", "personal", "catalog"] as const;

/** The parent's identity for the audit log: kind, skill and number (never an owner's id). */
function auditParent(ref: Readonly<Record<string, unknown>>) {
  const kind = PARENT_KINDS.find((k) => k === ref.kind);
  if (!kind || typeof ref.skillId !== "string" || typeof ref.semver !== "string") return {};
  return { parent: { kind, skillId: ref.skillId, semver: ref.semver } };
}

/** A new draft, private to its author, under the per-author cap (every start goes here). */
export async function createDraft(
  ctx: DraftContext,
  start: DraftStartInput,
): Promise<DraftOutcome<{ draft: DraftRecord }>> {
  const problem = startFilesProblem(start.files);
  if (problem) return fail(problem);
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    if (
      (await countOwnDrafts(tx, ctx.teamId, ctx.viewer.userId)) >= DRAFT_LIMITS.maxDraftsPerAuthor
    )
      return fail({ error: "draft_limit" });
    if (start.detach) await detachSynced(tx, ctx.teamId, start.detach);
    const draft = await insertDraft(
      tx,
      {
        teamId: ctx.teamId,
        ownerUserId: ctx.viewer.userId,
        name: start.name,
        startedFrom: start.startedFrom,
        parentRef: start.parentRef ?? null,
        fromThreadId: start.fromThreadId ?? null,
        origin: start.origin ? { ...start.origin } : null,
      },
      start.files,
    );
    await recordAudit(tx, {
      action: "skill.draft.created",
      teamId: ctx.teamId,
      target: {
        draftId: draft.id,
        name: draft.name,
        startedFrom: draft.startedFrom,
        // What was copied (review N3): the fork's parent version, or the conversation.
        ...(draft.parentRef ? auditParent(draft.parentRef) : {}),
        ...(draft.fromThreadId ? { fromThreadId: draft.fromThreadId } : {}),
        ...(start.origin
          ? {
              origin: {
                kind: start.origin.kind,
                url: start.origin.url,
                ...(start.origin.commit ? { commit: start.origin.commit } : {}),
                ...(start.origin.path ? { path: start.origin.path } : {}),
                fetchedSha256: start.origin.fetchedSha256,
              },
            }
          : {}),
        ...(start.via ? { via: start.via } : {}),
        ...(start.toolCall ?? {}),
      },
    });
    return { ok: true, draft };
  });
}

/** A blank draft: a SKILL.md skeleton under `name`, private to its author. */
export function createBlankDraft(
  ctx: DraftContext,
  name: string,
): Promise<DraftOutcome<{ draft: DraftRecord }>> {
  const files = new Map([[SKILL_MD_PATH, new TextEncoder().encode(skeletonSkillMd(name))]]);
  return createDraft(ctx, { name, startedFrom: "blank", files });
}

/** The draft and its file list, if the viewer may see it. */
export async function readDraft(ctx: DraftContext, id: string) {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await visibleDraft(tx, ctx.teamId, id, ctx.viewer);
    return draft ? { draft, files: await fileInfos(tx, ctx.teamId, id) } : null;
  });
}

/**
 * How many bytes a write of `path` may send, judged before the body is read (review S3): the
 * draft must be one the viewer may edit, and the body at most the draft's room (5 MiB less its
 * other files) and SKILL.md's cap. The write itself checks again under the draft's lock.
 */
export async function writeRoom(
  ctx: DraftContext,
  id: string,
  path: string,
): Promise<DraftOutcome<{ room: number; skillMd: boolean }>> {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await visibleDraft(tx, ctx.teamId, id, ctx.viewer);
    if (!draft) return fail({ error: "not_found" });
    const existing = (await fileInfos(tx, ctx.teamId, id)).find((f) => f.path === path);
    const room = DRAFT_LIMITS.maxDraftBytes - draft.sizeBytes + (existing?.size ?? 0);
    const skillMd = path === SKILL_MD_PATH;
    return {
      ok: true,
      room: skillMd ? Math.min(room, DRAFT_LIMITS.maxSkillMdBytes) : room,
      skillMd,
    };
  });
}

/** Writes one file at `rev`; a SKILL.md whose frontmatter parses renames the draft. */
export async function writeDraftFile(
  ctx: DraftContext,
  id: string,
  rev: number,
  path: string,
  bytes: Uint8Array,
): Promise<DraftOutcome<{ draft: DraftRecord }>> {
  try {
    return await writeFileInTx(ctx, id, rev, path, bytes);
  } catch (err) {
    if (!isSyncNameClash(err)) throw err;
    return fail({
      error: "name_taken",
      message: "Another draft saved from the same conversation has that name. Choose another.",
    });
  }
}

/** The unique save target per (author, conversation, name) refused a rename (KOBE-442 H1). */
export function isSyncNameClash(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    constraint?: unknown;
    cause?: { code?: unknown; constraint?: unknown };
  };
  const code = e.cause?.code ?? e.code;
  const constraint = e.cause?.constraint ?? e.constraint;
  return code === "23505" && constraint === "skill_drafts_thread_sync_uq";
}

function writeFileInTx(
  ctx: DraftContext,
  id: string,
  rev: number,
  path: string,
  bytes: Uint8Array,
): Promise<DraftOutcome<{ draft: DraftRecord }>> {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await lockedAt(tx, ctx, id, rev);
    if (isFailure(draft)) return fail(draft);
    const files = await fileInfos(tx, ctx.teamId, id);
    const problem = draftPathProblem(
      path,
      files.map((f) => f.path),
    );
    if (problem) return fail({ error: "invalid_path", message: `${path}: ${problem}.` });
    const existing = files.find((f) => f.path === path);
    if (!existing && files.length >= DRAFT_LIMITS.maxFiles)
      return fail({ error: "too_many_files" });
    if (path === SKILL_MD_PATH && bytes.length > DRAFT_LIMITS.maxSkillMdBytes)
      return fail({
        error: "file_too_large",
        message: `SKILL.md may be at most ${DRAFT_LIMITS.maxSkillMdBytes} bytes.`,
      });
    if (draft.sizeBytes - (existing?.size ?? 0) + bytes.length > DRAFT_LIMITS.maxDraftBytes)
      return fail({
        error: "draft_too_large",
        message: `A draft may hold at most ${DRAFT_LIMITS.maxDraftBytes} bytes in all.`,
      });
    await putFile(tx, ctx.teamId, id, path, bytes, ctx.viewer.userId);
    const name = path === SKILL_MD_PATH ? nameOf(bytes) : undefined;
    const next = await bumpRevision(tx, draft, ctx.viewer.userId, name ? { name } : {});
    return { ok: true, draft: next };
  });
}

/** The frontmatter `name` of a SKILL.md, when it parses (the draft keeps its name otherwise). */
function nameOf(bytes: Uint8Array): string | undefined {
  const parsed = parseSkillMd(bytes);
  return typeof parsed === "string" ? undefined : parsed.name;
}

export async function deleteDraftFile(
  ctx: DraftContext,
  id: string,
  rev: number,
  path: string,
): Promise<DraftOutcome<{ draft: DraftRecord }>> {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await lockedAt(tx, ctx, id, rev);
    if (isFailure(draft)) return fail(draft);
    if (!(await removeFile(tx, ctx.teamId, id, path))) return fail({ error: "not_found" });
    return { ok: true, draft: await bumpRevision(tx, draft, ctx.viewer.userId) };
  });
}

/** Shares the draft with the team's Builders and Team admins, or stops sharing: author only. */
export async function setDraftShared(
  ctx: DraftContext,
  id: string,
  rev: number,
  shared: boolean,
): Promise<DraftOutcome<{ draft: DraftRecord }>> {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await lockedAt(tx, ctx, id, rev);
    if (isFailure(draft)) return fail(draft);
    if (draft.ownerUserId !== ctx.viewer.userId)
      return fail({ error: "forbidden", message: "Only the draft's author can change sharing." });
    if (draft.shared === shared) return { ok: true, draft };
    const next = await bumpRevision(tx, draft, ctx.viewer.userId, { shared });
    await recordAudit(tx, {
      action: "skill.draft.shared",
      teamId: ctx.teamId,
      target: { draftId: id, shared },
    });
    return { ok: true, draft: next };
  });
}

/** Deletes the draft and its files: author only. Its saved versions stay. */
export async function removeDraft(
  ctx: DraftContext,
  id: string,
): Promise<DraftOutcome<Record<never, never>>> {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await visibleDraft(tx, ctx.teamId, id, ctx.viewer, true);
    if (!draft) return fail({ error: "not_found" });
    if (draft.ownerUserId !== ctx.viewer.userId)
      return fail({ error: "forbidden", message: "Only the draft's author can delete it." });
    await deleteDraft(tx, ctx.teamId, id);
    await recordAudit(tx, {
      action: "skill.draft.deleted",
      teamId: ctx.teamId,
      target: { draftId: id },
    });
    return { ok: true };
  });
}

/**
 * Replaces every file of the author's draft with `files` (Save to Workbench, KOBE-322): files no
 * longer there are deleted, the rest written, one new revision, `skill.draft.updated`. Author
 * only; the draft's own limits are checked on `files` first (`startFilesProblem`).
 */
export async function replaceDraftFiles(
  ctx: DraftContext,
  id: string,
  files: ReadonlyMap<string, Uint8Array>,
  source: {
    readonly fromThreadId?: string;
    readonly via?: "tool";
    readonly toolCall?: ToolCallRef;
  } = {},
): Promise<DraftOutcome<{ draft: DraftRecord }>> {
  const problem = startFilesProblem(files);
  if (problem) return fail(problem);
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await visibleDraft(tx, ctx.teamId, id, ctx.viewer, true);
    if (!draft) return fail({ error: "not_found" });
    if (draft.ownerUserId !== ctx.viewer.userId)
      return fail({ error: "forbidden", message: "Only the draft's author can sync into it." });
    // The agent writes only into a private draft nobody changed since its last save (M2).
    if (source.via === "tool" && draft.shared)
      return fail({ error: "not_sync_target", because: "shared" });
    if (source.via === "tool" && draft.rev !== draft.syncedRev)
      return fail({ error: "not_sync_target", because: "edited" });
    for (const f of await fileInfos(tx, ctx.teamId, id))
      if (!files.has(f.path)) await removeFile(tx, ctx.teamId, id, f.path);
    for (const [path, bytes] of files)
      await putFile(tx, ctx.teamId, id, path, bytes, ctx.viewer.userId);
    const name = files.get(SKILL_MD_PATH);
    const renamed = name ? nameOf(name) : undefined;
    const bumped = await bumpRevision(
      tx,
      draft,
      ctx.viewer.userId,
      renamed ? { name: renamed } : {},
    );
    await markSynced(tx, ctx.teamId, id);
    const next = { ...bumped, syncedRev: bumped.rev };
    await recordAudit(tx, {
      action: "skill.draft.updated",
      teamId: ctx.teamId,
      target: {
        draftId: id,
        ...(source.fromThreadId ? { fromThreadId: source.fromThreadId } : {}),
        ...(source.via ? { via: source.via } : {}),
        ...(source.toolCall ?? {}),
      },
    });
    return { ok: true, draft: next };
  });
}
