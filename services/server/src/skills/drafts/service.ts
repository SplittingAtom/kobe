import { withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { parseSkillMd } from "../skill-md.js";
import { DRAFT_LIMITS, SKILL_MD_PATH, draftPathProblem, skeletonSkillMd } from "./files.js";
import {
  bumpRevision,
  changedBy,
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

/** A blank draft: a SKILL.md skeleton under `name`, private to its author. */
export async function createBlankDraft(
  ctx: DraftContext,
  name: string,
): Promise<DraftOutcome<{ draft: DraftRecord }>> {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    if (
      (await countOwnDrafts(tx, ctx.teamId, ctx.viewer.userId)) >= DRAFT_LIMITS.maxDraftsPerAuthor
    )
      return fail({ error: "draft_limit" });
    const files = new Map([[SKILL_MD_PATH, new TextEncoder().encode(skeletonSkillMd(name))]]);
    const draft = await insertDraft(
      tx,
      { teamId: ctx.teamId, ownerUserId: ctx.viewer.userId, name, startedFrom: "blank" },
      files,
    );
    await recordAudit(tx, {
      action: "skill.draft.created",
      teamId: ctx.teamId,
      target: { draftId: draft.id, name: draft.name, startedFrom: draft.startedFrom },
    });
    return { ok: true, draft };
  });
}

/** The draft and its file list, if the viewer may see it. */
export async function readDraft(ctx: DraftContext, id: string) {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await visibleDraft(tx, ctx.teamId, id, ctx.viewer);
    return draft ? { draft, files: await fileInfos(tx, ctx.teamId, id) } : null;
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
    await putFile(tx, ctx.teamId, id, path, bytes);
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
