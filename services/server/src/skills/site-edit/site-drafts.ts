import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import type { BlobStore } from "../../retention/blobs.js";
import { blockedAmong } from "../blocklist.js";
import { DRAFT_LIMITS, SKILL_MD_PATH, draftContent, draftPathProblem } from "../drafts/files.js";
import { detachInTx } from "./kobe-detach.js";
import { isSiteAdmin } from "./site-admin.js";
import {
  RETIRED_STATUSES,
  packageFiles,
  storedOf,
  storedVersion,
  type SiteDraftInfo,
} from "./catalog-view.js";

/**
 * Site drafts of catalog skills (KOBE-495): one per catalog skill, shared by the Site admins,
 * seeded from a chosen version's package and changed file by file under the Workbench's rules
 * (package paths, file count, SKILL.md cap, 5 MiB in all) with the same compare-and-set revision.
 * Every call re-checks that the caller is an active Site admin inside its transaction (the route
 * checks the session's role too). Starting a draft of a Kobe-shipped skill detaches it, in the same
 * transaction, under the skill's row lock (the seed takes that lock too). Blocklisted skills and
 * retired ones (Deprecated, Archived: Restore first) can't be edited.
 */

export type SiteDraftFailure =
  | { readonly error: "forbidden" | "not_found" | "too_many_files" }
  | { readonly error: "retired" | "blocklisted" | "not_stored" }
  | { readonly error: "draft_exists"; readonly draft: SiteDraftInfo }
  | { readonly error: "stale_revision"; readonly rev: number; readonly changedBy: string }
  | {
      readonly error: "invalid_path" | "file_too_large" | "draft_too_large";
      readonly message: string;
    };

export type SiteDraftOutcome<T> =
  ({ readonly ok: true } & T) | ({ readonly ok: false } & SiteDraftFailure);

const fail = (f: SiteDraftFailure) => ({ ok: false as const, ...f });

export interface SiteDraftRecord {
  readonly id: string;
  readonly skillId: string;
  readonly baseVersionId: string;
  readonly rev: number;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SiteDraftFile {
  readonly path: string;
  readonly size: number;
  readonly kind: "text" | "binary";
  readonly updatedAt: string;
}

class Refused extends Error {
  constructor(readonly failure: SiteDraftFailure) {
    super(failure.error);
  }
}

async function requireAdmin(tx: KobeTx, userId: string): Promise<void> {
  if (!(await isSiteAdmin(tx, userId))) throw new Refused({ error: "forbidden" });
}

/** Runs `fn` as a Site admin; a refusal thrown inside rolls back and comes back as a failure. */
export async function asSiteAdmin<T>(
  db: KobeDb,
  userId: string,
  fn: (tx: KobeTx) => Promise<T>,
): Promise<SiteDraftOutcome<T>> {
  try {
    const value = await db.transaction(async (tx) => {
      await requireAdmin(tx, userId);
      return fn(tx);
    });
    return { ok: true, ...value } as SiteDraftOutcome<T>;
  } catch (err) {
    if (err instanceof Refused) return fail(err.failure);
    throw err;
  }
}

export const refuse = (f: SiteDraftFailure): never => {
  throw new Refused(f);
};

type DraftRow = {
  id: string;
  skill_id: string;
  base_version_id: string;
  rev: number;
  size_bytes: number;
  file_count: number;
  updated_at: Date;
  updated_by: string;
};

const recordOf = (r: DraftRow): SiteDraftRecord => ({
  id: r.id,
  skillId: r.skill_id,
  baseVersionId: r.base_version_id,
  rev: Number(r.rev),
  sizeBytes: Number(r.size_bytes),
  fileCount: Number(r.file_count),
  updatedAt: new Date(r.updated_at).toISOString(),
  updatedBy: r.updated_by,
});

const DRAFT_COLUMNS = sql`d.id, d.skill_id, d.base_version_id, d.rev, d.size_bytes, d.file_count,
  d.updated_at, u.name AS updated_by`;

export async function draftOf(
  tx: KobeTx | KobeDb,
  skillId: string,
  lock = false,
): Promise<SiteDraftRecord | null> {
  const { rows } = await tx.execute<DraftRow>(sql`
    SELECT ${DRAFT_COLUMNS} FROM site_skill_drafts d JOIN users u ON u.id = d.updated_by
     WHERE d.skill_id = ${skillId} ${lock ? sql`FOR UPDATE OF d` : sql``}`);
  const r = rows[0];
  return r ? recordOf(r) : null;
}

export async function draftFiles(tx: KobeTx | KobeDb, draftId: string): Promise<SiteDraftFile[]> {
  const { rows } = await tx.execute<{
    path: string;
    size: number;
    text: boolean;
    updated_at: Date;
  }>(sql`
    SELECT path, size, text_content IS NOT NULL AS text, updated_at
      FROM site_skill_draft_files WHERE draft_id = ${draftId} ORDER BY path`);
  return rows.map((r) => ({
    path: r.path,
    size: Number(r.size),
    kind: r.text ? "text" : "binary",
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function draftFile(
  tx: KobeTx | KobeDb,
  draftId: string,
  path: string,
): Promise<{ bytes: Uint8Array; kind: "text" | "binary" } | null> {
  const { rows } = await tx.execute<{ text_content: string | null; bytes: Buffer | null }>(sql`
    SELECT text_content, bytes FROM site_skill_draft_files
     WHERE draft_id = ${draftId} AND path = ${path}`);
  const r = rows[0];
  if (!r) return null;
  return r.text_content !== null
    ? { bytes: new TextEncoder().encode(r.text_content), kind: "text" }
    : { bytes: new Uint8Array(r.bytes ?? Buffer.alloc(0)), kind: "binary" };
}

export async function allDraftFiles(
  tx: KobeTx | KobeDb,
  draftId: string,
): Promise<Map<string, Uint8Array>> {
  const { rows } = await tx.execute<{
    path: string;
    text_content: string | null;
    bytes: Buffer | null;
  }>(sql`
    SELECT path, text_content, bytes FROM site_skill_draft_files WHERE draft_id = ${draftId}`);
  return new Map(
    rows.map((r) => [
      r.path,
      r.text_content !== null
        ? new TextEncoder().encode(r.text_content)
        : new Uint8Array(r.bytes ?? Buffer.alloc(0)),
    ]),
  );
}

async function putFile(
  tx: KobeTx,
  draftId: string,
  path: string,
  bytes: Uint8Array,
  writer: string,
): Promise<void> {
  const parsed = draftContent(bytes);
  const text = "text" in parsed ? parsed.text : null;
  const raw = "bytes" in parsed ? parsed.bytes : null;
  await tx.execute(sql`
    INSERT INTO site_skill_draft_files (draft_id, path, text_content, bytes, size, updated_by)
    VALUES (${draftId}, ${path}, ${text}, ${raw}, ${bytes.length}, ${writer})
    ON CONFLICT (draft_id, path) DO UPDATE SET text_content = excluded.text_content,
      bytes = excluded.bytes, size = excluded.size, updated_by = excluded.updated_by,
      updated_at = now()`);
}

/** The next revision, its size and count recomputed from the files (same transaction). */
async function bump(tx: KobeTx, draftId: string, userId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE site_skill_drafts d SET rev = d.rev + 1, updated_by = ${userId}, updated_at = now(),
      size_bytes = COALESCE((SELECT sum(size) FROM site_skill_draft_files f WHERE f.draft_id = d.id), 0),
      file_count = (SELECT count(*) FROM site_skill_draft_files f WHERE f.draft_id = d.id)
     WHERE d.id = ${draftId}`);
}

/** Locks the skill row; refuses a retired one. */
export async function lockedSkill(
  tx: KobeTx,
  skillId: string,
): Promise<{ name: string; publisher: "kobe" | "maintainer"; status: string }> {
  const { rows } = await tx.execute<{
    name: string;
    publisher: "kobe" | "maintainer";
    status: string;
  }>(
    sql`SELECT name, publisher::text AS publisher, status::text AS status
          FROM registry_skills WHERE id = ${skillId} FOR UPDATE`,
  );
  const skill = rows[0];
  if (!skill) return refuse({ error: "not_found" });
  if (RETIRED_STATUSES.includes(skill.status)) return refuse({ error: "retired" });
  return skill;
}

/** Any of the skill's versions' bytes on the blocklist: it can't be edited back in. */
export async function refuseBlocklisted(tx: KobeTx, hashes: readonly string[]): Promise<void> {
  if ((await blockedAmong(tx, hashes)).length > 0) refuse({ error: "blocklisted" });
}

const READ_ONLY_PATHS = new Set(["provenance.json"]);

/**
 * Starts the site draft of `skillId` from `versionId`'s package. One draft per skill: an existing
 * one is answered `draft_exists` unless `replace`. A Kobe skill is detached here.
 */
export async function startSiteDraft(
  deps: { readonly db: KobeDb; readonly blobs: BlobStore },
  userId: string,
  skillId: string,
  versionId: string,
  replace: boolean,
): Promise<SiteDraftOutcome<{ draft: SiteDraftRecord }>> {
  const stored = await storedVersion(deps.db, skillId, versionId);
  if (!stored) return fail({ error: "not_found" });
  const files = await packageFiles(deps.blobs, storedOf(stored));
  if (!files) return fail({ error: "not_stored" });
  return asSiteAdmin(deps.db, userId, async (tx) => {
    await lockedSkill(tx, skillId);
    const { rows } = await tx.execute<{ runtime_hash: string; package_hash: string }>(sql`
      SELECT runtime_hash, package_hash FROM registry_versions WHERE skill_id = ${skillId}`);
    await refuseBlocklisted(tx, [
      ...new Set(rows.flatMap((r) => [r.runtime_hash, r.package_hash])),
    ]);
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM site_skill_drafts WHERE skill_id = ${skillId} FOR UPDATE`);
    if (existing.rows[0]) {
      if (!replace) {
        const info = await draftOf(tx, skillId);
        if (info)
          refuse({
            error: "draft_exists",
            draft: {
              baseVersionId: info.baseVersionId,
              baseSemver: "",
              rev: info.rev,
              updatedAt: info.updatedAt,
              updatedBy: info.updatedBy,
            },
          });
      }
      await tx.execute(sql`DELETE FROM site_skill_drafts WHERE skill_id = ${skillId}`);
    }
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO site_skill_drafts (skill_id, base_version_id, created_by, updated_by)
      VALUES (${skillId}, ${versionId}, ${userId}, ${userId}) RETURNING id`);
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("site draft insert returned no row");
    for (const [path, bytes] of files)
      if (!READ_ONLY_PATHS.has(path)) await putFile(tx, id, path, bytes, userId);
    await bump(tx, id, userId);
    // The first edit of a Kobe skill detaches it, with the draft (KOBE-494 review pattern).
    await detachInTx(tx, skillId, userId);
    const draft = await draftOf(tx, skillId);
    if (!draft) throw new Error("site draft vanished");
    return { draft };
  });
}

/** The draft at `rev`, locked; a stale revision names who changed it. */
async function lockedAt(tx: KobeTx, skillId: string, rev: number): Promise<SiteDraftRecord> {
  await lockedSkill(tx, skillId);
  const draft = await draftOf(tx, skillId, true);
  if (!draft) return refuse({ error: "not_found" });
  if (draft.rev !== rev)
    return refuse({ error: "stale_revision", rev: draft.rev, changedBy: draft.updatedBy });
  return draft;
}

/** Bytes a write of `path` may still take (checked again under the lock). */
export async function writeRoom(
  db: KobeDb,
  skillId: string,
  path: string,
): Promise<{ room: number; skillMd: boolean } | null> {
  const draft = await draftOf(db, skillId);
  if (!draft) return null;
  const existing = (await draftFiles(db, draft.id)).find((f) => f.path === path);
  const room = DRAFT_LIMITS.maxDraftBytes - draft.sizeBytes + (existing?.size ?? 0);
  const skillMd = path === SKILL_MD_PATH;
  return { room: skillMd ? Math.min(room, DRAFT_LIMITS.maxSkillMdBytes) : room, skillMd };
}

export function writeSiteDraftFile(
  db: KobeDb,
  userId: string,
  skillId: string,
  rev: number,
  path: string,
  bytes: Uint8Array,
): Promise<SiteDraftOutcome<{ draft: SiteDraftRecord }>> {
  return asSiteAdmin(db, userId, async (tx) => {
    const draft = await lockedAt(tx, skillId, rev);
    if (READ_ONLY_PATHS.has(path))
      refuse({ error: "invalid_path", message: `${path}: Kobe writes provenance.json itself.` });
    const files = await draftFiles(tx, draft.id);
    const problem = draftPathProblem(
      path,
      files.map((f) => f.path),
    );
    if (problem) refuse({ error: "invalid_path", message: `${path}: ${problem}.` });
    const existing = files.find((f) => f.path === path);
    if (!existing && files.length >= DRAFT_LIMITS.maxFiles) refuse({ error: "too_many_files" });
    if (path === SKILL_MD_PATH && bytes.length > DRAFT_LIMITS.maxSkillMdBytes)
      refuse({
        error: "file_too_large",
        message: `SKILL.md may be at most ${DRAFT_LIMITS.maxSkillMdBytes} bytes.`,
      });
    if (draft.sizeBytes - (existing?.size ?? 0) + bytes.length > DRAFT_LIMITS.maxDraftBytes)
      refuse({
        error: "draft_too_large",
        message: `A draft may hold at most ${DRAFT_LIMITS.maxDraftBytes} bytes in all.`,
      });
    await putFile(tx, draft.id, path, bytes, userId);
    await bump(tx, draft.id, userId);
    const next = await draftOf(tx, skillId);
    if (!next) throw new Error("site draft vanished");
    return { draft: next };
  });
}

export function deleteSiteDraftFile(
  db: KobeDb,
  userId: string,
  skillId: string,
  rev: number,
  path: string,
): Promise<SiteDraftOutcome<{ draft: SiteDraftRecord }>> {
  return asSiteAdmin(db, userId, async (tx) => {
    const draft = await lockedAt(tx, skillId, rev);
    const gone = await tx.execute(sql`
      DELETE FROM site_skill_draft_files WHERE draft_id = ${draft.id} AND path = ${path}
      RETURNING path`);
    if (gone.rows.length === 0) refuse({ error: "not_found" });
    await bump(tx, draft.id, userId);
    const next = await draftOf(tx, skillId);
    if (!next) throw new Error("site draft vanished");
    return { draft: next };
  });
}

/** Discards the draft (the skill stays detached until Reset to Kobe). */
export function discardSiteDraft(
  db: KobeDb,
  userId: string,
  skillId: string,
): Promise<SiteDraftOutcome<{ discarded: true }>> {
  return asSiteAdmin(db, userId, async (tx) => {
    const gone = await tx.execute(sql`
      DELETE FROM site_skill_drafts WHERE skill_id = ${skillId} RETURNING id`);
    if (gone.rows.length === 0) refuse({ error: "not_found" });
    return { discarded: true as const };
  });
}
