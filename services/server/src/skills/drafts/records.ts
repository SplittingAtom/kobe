import {
  and,
  asc,
  desc,
  eq,
  or,
  skillDraftFiles,
  skillDrafts,
  sql,
  users,
  type KobeTx,
  type SkillDraftStart,
  type TeamRole,
} from "@kobe/db";
import { teamRoleAllows } from "../../authz/permissions.js";
import { draftContent } from "./files.js";

/**
 * Workbench draft records (KOBE-320, SK11). Every function runs inside `withTeam` (RLS keeps
 * teams apart) and names `team_id` too. Who sees a draft is decided here: its author always; the
 * team's Builders and Team admins once it is shared; nobody else, and a draft nobody may see
 * answers as missing.
 */

export interface DraftRecord {
  readonly id: string;
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly shared: boolean;
  readonly name: string;
  readonly startedFrom: SkillDraftStart;
  readonly parentRef: Record<string, unknown> | null;
  readonly fromThreadId: string | null;
  /** Someone besides the author changed it (sticky, kept by the database). */
  readonly coEdited: boolean;
  readonly rev: number;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

export interface DraftFileInfo {
  readonly path: string;
  readonly size: number;
  readonly kind: "text" | "binary";
  readonly updatedAt: Date;
}

export interface DraftViewer {
  readonly userId: string;
  readonly role: TeamRole;
}

/** Co-editors of a shared draft: Builders and Team admins (SK11). */
const coEditor = (viewer: DraftViewer) => teamRoleAllows(viewer.role, "team.skills.publish");

export const canEdit = (draft: DraftRecord, viewer: DraftViewer): boolean =>
  draft.ownerUserId === viewer.userId || (draft.shared && coEditor(viewer));

const columns = {
  id: skillDrafts.id,
  teamId: skillDrafts.teamId,
  ownerUserId: skillDrafts.ownerUserId,
  shared: skillDrafts.shared,
  name: skillDrafts.name,
  startedFrom: skillDrafts.startedFrom,
  parentRef: skillDrafts.parentRef,
  fromThreadId: skillDrafts.fromThreadId,
  coEdited: skillDrafts.coEdited,
  rev: skillDrafts.rev,
  sizeBytes: skillDrafts.sizeBytes,
  fileCount: skillDrafts.fileCount,
  createdAt: skillDrafts.createdAt,
  updatedAt: skillDrafts.updatedAt,
  updatedBy: skillDrafts.updatedBy,
};

const byId = (teamId: string, id: string) =>
  and(eq(skillDrafts.teamId, teamId), eq(skillDrafts.id, id));

/** The draft if `viewer` may see it; `lock` takes its row lock (writers serialize on it). */
export async function visibleDraft(
  tx: KobeTx,
  teamId: string,
  id: string,
  viewer: DraftViewer,
  lock = false,
): Promise<DraftRecord | null> {
  const query = tx.select(columns).from(skillDrafts).where(byId(teamId, id));
  const [row] = lock ? await query.for("update") : await query;
  return row && canEdit(row, viewer) ? row : null;
}

/** A page of the list: drafts changed before this point (newest change first). */
export interface DraftCursor {
  /** `updated_at` to the microsecond, as Postgres prints it in UTC (a Date would round it). */
  readonly updatedAt: string;
  readonly id: string;
}

export const DRAFT_PAGE = 100;

/**
 * The viewer's own drafts and, for co-editors, the team's shared ones; newest change first, one
 * page of {@link DRAFT_PAGE} after `cursor` (one more row read to tell whether there is a next).
 */
export async function listVisibleDrafts(
  tx: KobeTx,
  teamId: string,
  viewer: DraftViewer,
  cursor: DraftCursor | null = null,
): Promise<{ readonly drafts: DraftRecord[]; readonly next: DraftCursor | null }> {
  const mine = eq(skillDrafts.ownerUserId, viewer.userId);
  const after = cursor
    ? sql`(${skillDrafts.updatedAt}, ${skillDrafts.id}) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`
    : undefined;
  const rows = await tx
    .select({
      ...columns,
      at: sql<string>`to_char(${skillDrafts.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(skillDrafts)
    .where(
      and(
        eq(skillDrafts.teamId, teamId),
        coEditor(viewer) ? or(mine, skillDrafts.shared) : mine,
        after,
      ),
    )
    .orderBy(desc(skillDrafts.updatedAt), desc(skillDrafts.id))
    .limit(DRAFT_PAGE + 1);
  const page = rows.slice(0, DRAFT_PAGE);
  const last = page.at(-1);
  return {
    drafts: page.map(({ at: _at, ...draft }) => draft),
    next: rows.length > DRAFT_PAGE && last ? { updatedAt: last.at, id: last.id } : null,
  };
}

/** The author's drafts in the team, under a lock per (team, author) so creates don't race the cap. */
export async function countOwnDrafts(tx: KobeTx, teamId: string, userId: string): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.skill_drafts:${teamId}:${userId}`}, 0))`,
  );
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM skill_drafts
     WHERE team_id = ${teamId} AND owner_user_id = ${userId}`);
  return rows[0]?.n ?? 0;
}

export interface NewDraft {
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly startedFrom: SkillDraftStart;
  readonly parentRef?: Record<string, unknown> | null;
  readonly fromThreadId?: string | null;
}

/** Inserts the draft and its first files; the database counts their size. */
export async function insertDraft(
  tx: KobeTx,
  draft: NewDraft,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<DraftRecord> {
  const [row] = await tx
    .insert(skillDrafts)
    .values({
      teamId: draft.teamId,
      ownerUserId: draft.ownerUserId,
      updatedBy: draft.ownerUserId,
      name: draft.name,
      startedFrom: draft.startedFrom,
      parentRef: draft.parentRef ?? null,
      fromThreadId: draft.fromThreadId ?? null,
    })
    .returning({ id: skillDrafts.id });
  if (!row) throw new Error("draft insert returned no row");
  for (const [path, bytes] of files)
    await putFile(tx, draft.teamId, row.id, path, bytes, draft.ownerUserId);
  const [saved] = await tx.select(columns).from(skillDrafts).where(byId(draft.teamId, row.id));
  if (!saved) throw new Error("draft vanished after insert");
  return saved;
}

export async function fileInfos(
  tx: KobeTx,
  teamId: string,
  draftId: string,
): Promise<DraftFileInfo[]> {
  const rows = await tx
    .select({
      path: skillDraftFiles.path,
      size: skillDraftFiles.size,
      binary: sql<boolean>`${skillDraftFiles.bytes} IS NOT NULL`,
      updatedAt: skillDraftFiles.updatedAt,
    })
    .from(skillDraftFiles)
    .where(and(eq(skillDraftFiles.teamId, teamId), eq(skillDraftFiles.draftId, draftId)))
    .orderBy(asc(skillDraftFiles.path));
  return rows.map((r) => ({
    path: r.path,
    size: r.size,
    kind: r.binary ? "binary" : "text",
    updatedAt: r.updatedAt,
  }));
}

/** One file's bytes and kind, or null. */
export async function readFile(
  tx: KobeTx,
  teamId: string,
  draftId: string,
  path: string,
): Promise<{ readonly bytes: Uint8Array; readonly kind: "text" | "binary" } | null> {
  const [row] = await tx
    .select({ text: skillDraftFiles.textContent, bytes: skillDraftFiles.bytes })
    .from(skillDraftFiles)
    .where(fileKey(teamId, draftId, path));
  if (!row) return null;
  return row.bytes
    ? { bytes: new Uint8Array(row.bytes), kind: "binary" }
    : { bytes: new TextEncoder().encode(row.text ?? ""), kind: "text" };
}

/** Every file of the draft, path to bytes (Save version). */
export async function readAllFiles(
  tx: KobeTx,
  teamId: string,
  draftId: string,
): Promise<Map<string, Uint8Array>> {
  const rows = await tx
    .select({
      path: skillDraftFiles.path,
      text: skillDraftFiles.textContent,
      bytes: skillDraftFiles.bytes,
    })
    .from(skillDraftFiles)
    .where(and(eq(skillDraftFiles.teamId, teamId), eq(skillDraftFiles.draftId, draftId)));
  const encoder = new TextEncoder();
  return new Map(
    rows.map((r) => [r.path, r.bytes ? new Uint8Array(r.bytes) : encoder.encode(r.text ?? "")]),
  );
}

const fileKey = (teamId: string, draftId: string, path: string) =>
  and(
    eq(skillDraftFiles.teamId, teamId),
    eq(skillDraftFiles.draftId, draftId),
    eq(skillDraftFiles.path, path),
  );

/** Writes one file: text (valid UTF-8 without NUL) inline, anything else as bytes. */
export async function putFile(
  tx: KobeTx,
  teamId: string,
  draftId: string,
  path: string,
  bytes: Uint8Array,
  writer: string,
): Promise<void> {
  const parsed = draftContent(bytes);
  const content =
    "text" in parsed
      ? { textContent: parsed.text, bytes: null }
      : { textContent: null, bytes: parsed.bytes };
  await tx
    .insert(skillDraftFiles)
    .values({ teamId, draftId, path, size: bytes.length, updatedBy: writer, ...content })
    .onConflictDoUpdate({
      target: [skillDraftFiles.teamId, skillDraftFiles.draftId, skillDraftFiles.path],
      set: { ...content, size: bytes.length, updatedBy: writer, updatedAt: sql`now()` },
    });
}

/** Removes one file; whether it was there. */
export async function removeFile(
  tx: KobeTx,
  teamId: string,
  draftId: string,
  path: string,
): Promise<boolean> {
  const gone = await tx
    .delete(skillDraftFiles)
    .where(fileKey(teamId, draftId, path))
    .returning({ path: skillDraftFiles.path });
  return gone.length > 0;
}

/** One change to the draft: the next revision, by `userId`, with any column changes. */
export async function bumpRevision(
  tx: KobeTx,
  draft: DraftRecord,
  userId: string,
  changes: { readonly name?: string; readonly shared?: boolean } = {},
): Promise<DraftRecord> {
  const [row] = await tx
    .update(skillDrafts)
    .set({
      ...changes,
      rev: sql`${skillDrafts.rev} + 1`,
      updatedAt: sql`now()`,
      updatedBy: userId,
    })
    .where(byId(draft.teamId, draft.id))
    .returning(columns);
  if (!row) throw new Error("locked draft vanished");
  return row;
}

export async function deleteDraft(tx: KobeTx, teamId: string, id: string): Promise<void> {
  await tx.delete(skillDrafts).where(byId(teamId, id));
}

/** Who made the draft's last change, for a stale write's "changed by" (SK11). */
export async function changedBy(
  tx: KobeTx,
  userId: string,
): Promise<{ readonly id: string; readonly name: string }> {
  const [row] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return { id: userId, name: row?.name ?? "someone" };
}
