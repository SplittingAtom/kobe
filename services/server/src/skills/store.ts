import {
  and,
  desc,
  eq,
  sql,
  installSkills,
  installSkillVersions,
  teamSkills,
  teamSkillVersions,
  withTeam,
  type KobeDb,
  type KobeTx,
  type SkillSource,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { MAX_LIVE_SKILLS, MAX_SKILL_VERSIONS } from "./limits.js";

/**
 * Skill bundles in the database (KOBE-78). Team skills live in RLS tables and are always touched
 * inside `withTeam`; personal skills live in install-wide tables, where the owner filter below is
 * the only wall between users, so every personal query applies it. Each upload is one immutable
 * version (the database refuses to change or delete it); uploads to a location are serialized by
 * an advisory lock, so version numbers are consecutive and the slug cap holds.
 */
export type SkillLocation =
  | { readonly scope: "team"; readonly teamId: string }
  | { readonly scope: "personal"; readonly ownerUserId: string };

export type SkillScope = SkillLocation["scope"];

export interface SkillRecord {
  readonly id: string;
  readonly scope: SkillScope;
  readonly slug: string;
  readonly description: string;
  readonly latestVersion: number;
  readonly ownerUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SkillVersionRecord {
  readonly version: number;
  readonly frontmatter: Record<string, unknown>;
  readonly source: SkillSource;
  readonly contentHash: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
  readonly uploadedBy: string;
  readonly uploadedAt: Date;
}

export interface NewSkillVersion {
  readonly slug: string;
  readonly description: string;
  readonly frontmatter: Record<string, unknown>;
  readonly source: SkillSource;
  readonly contentHash: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
  readonly uploadedBy: string;
}

export type UploadError = "unchanged" | "skill_limit" | "version_limit";
export type UploadResult =
  | { readonly ok: true; readonly skill: SkillRecord; readonly version: SkillVersionRecord }
  | { readonly ok: false; readonly error: UploadError };

function inLocation<T>(db: KobeDb, location: SkillLocation, fn: (tx: KobeTx) => Promise<T>) {
  return location.scope === "team"
    ? withTeam(db, location.teamId, fn)
    : db.transaction((tx) => fn(tx));
}

const lockKey = (l: SkillLocation) =>
  l.scope === "team" ? `kobe.skills.team:${l.teamId}` : `kobe.skills.personal:${l.ownerUserId}`;

type TeamRow = typeof teamSkills.$inferSelect;
type InstallRow = typeof installSkills.$inferSelect;

function toRecord(scope: SkillScope, row: TeamRow | InstallRow): SkillRecord {
  return {
    id: row.id,
    scope,
    slug: row.slug,
    description: row.description,
    latestVersion: row.latestVersion,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Stores `input` as the next version of the skill named `input.slug`, creating the skill if new. */
export function uploadSkillVersion(
  db: KobeDb,
  location: SkillLocation,
  input: NewSkillVersion,
): Promise<UploadResult> {
  return inLocation(db, location, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(location)}, 0))`);
    const existing = await findBySlug(tx, location, input.slug);
    if (existing) {
      const latest = await versionOf(tx, location, existing.id, existing.latestVersion);
      if (latest?.contentHash === input.contentHash) return { ok: false, error: "unchanged" };
      if (existing.latestVersion >= MAX_SKILL_VERSIONS)
        return { ok: false, error: "version_limit" };
    } else if ((await countSkills(tx, location)) >= MAX_LIVE_SKILLS) {
      return { ok: false, error: "skill_limit" };
    }
    const skill = existing
      ? await bumpSkill(tx, location, existing, input)
      : await insertSkill(tx, location, input);
    const number = skill.latestVersion;
    const version = await insertVersion(tx, location, skill.id, number, input);
    await recordAudit(tx, {
      action: "skill.uploaded",
      teamId: location.scope === "team" ? location.teamId : null,
      target: {
        skillId: skill.id,
        scope: location.scope,
        slug: skill.slug,
        version: number,
        bundleHash: input.contentHash,
        bytes: input.sizeBytes,
        files: input.fileCount,
        source: input.source,
      },
    });
    return { ok: true, skill, version };
  });
}

async function findBySlug(
  tx: KobeTx,
  location: SkillLocation,
  slug: string,
): Promise<SkillRecord | null> {
  if (location.scope === "team") {
    const [row] = await tx.select().from(teamSkills).where(eq(teamSkills.slug, slug));
    return row ? toRecord("team", row) : null;
  }
  const [row] = await tx
    .select()
    .from(installSkills)
    .where(and(eq(installSkills.ownerUserId, location.ownerUserId), eq(installSkills.slug, slug)));
  return row ? toRecord("personal", row) : null;
}

async function countSkills(tx: KobeTx, location: SkillLocation): Promise<number> {
  const rows =
    location.scope === "team"
      ? await tx.select({ id: teamSkills.id }).from(teamSkills)
      : await tx
          .select({ id: installSkills.id })
          .from(installSkills)
          .where(eq(installSkills.ownerUserId, location.ownerUserId));
  return rows.length;
}

async function insertSkill(
  tx: KobeTx,
  location: SkillLocation,
  input: NewSkillVersion,
): Promise<SkillRecord> {
  const values = { slug: input.slug, description: input.description };
  const [row] =
    location.scope === "team"
      ? await tx
          .insert(teamSkills)
          .values({ ...values, teamId: location.teamId, ownerUserId: input.uploadedBy })
          .returning()
      : await tx
          .insert(installSkills)
          .values({ ...values, ownerUserId: location.ownerUserId })
          .returning();
  if (!row) throw new Error("skill insert returned no row");
  return toRecord(location.scope, row);
}

async function bumpSkill(
  tx: KobeTx,
  location: SkillLocation,
  skill: SkillRecord,
  input: NewSkillVersion,
): Promise<SkillRecord> {
  const set = {
    description: input.description,
    latestVersion: skill.latestVersion + 1,
    updatedAt: new Date(),
  };
  const [row] =
    location.scope === "team"
      ? await tx.update(teamSkills).set(set).where(eq(teamSkills.id, skill.id)).returning()
      : await tx
          .update(installSkills)
          .set(set)
          .where(
            and(
              eq(installSkills.id, skill.id),
              eq(installSkills.ownerUserId, location.ownerUserId),
            ),
          )
          .returning();
  if (!row) throw new Error("skill update returned no row");
  return toRecord(location.scope, row);
}

async function insertVersion(
  tx: KobeTx,
  location: SkillLocation,
  skillId: string,
  version: number,
  input: NewSkillVersion,
): Promise<SkillVersionRecord> {
  const values = {
    skillId,
    version,
    frontmatter: input.frontmatter,
    source: input.source,
    contentHash: input.contentHash,
    storageKey: input.storageKey,
    sizeBytes: input.sizeBytes,
    fileCount: input.fileCount,
    uncompressedBytes: input.uncompressedBytes,
    uploadedBy: input.uploadedBy,
  };
  const [row] =
    location.scope === "team"
      ? await tx
          .insert(teamSkillVersions)
          .values({ ...values, teamId: location.teamId })
          .returning()
      : await tx.insert(installSkillVersions).values(values).returning();
  if (!row) throw new Error("skill version insert returned no row");
  return toVersion(row);
}

function toVersion(row: typeof installSkillVersions.$inferSelect): SkillVersionRecord {
  return {
    version: row.version,
    frontmatter: row.frontmatter,
    source: row.source,
    contentHash: row.contentHash,
    storageKey: row.storageKey,
    sizeBytes: row.sizeBytes,
    fileCount: row.fileCount,
    uncompressedBytes: row.uncompressedBytes,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt,
  };
}

export function listSkills(db: KobeDb, location: SkillLocation): Promise<SkillRecord[]> {
  return inLocation(db, location, async (tx) => {
    const rows =
      location.scope === "team"
        ? await tx.select().from(teamSkills).orderBy(teamSkills.slug)
        : await tx
            .select()
            .from(installSkills)
            .where(eq(installSkills.ownerUserId, location.ownerUserId))
            .orderBy(installSkills.slug);
    return rows.map((r) => toRecord(location.scope, r));
  });
}

export function findSkill(
  db: KobeDb,
  location: SkillLocation,
  id: string,
): Promise<SkillRecord | null> {
  return inLocation(db, location, (tx) => findById(tx, location, id));
}

async function findById(tx: KobeTx, location: SkillLocation, id: string) {
  if (location.scope === "team") {
    const [row] = await tx.select().from(teamSkills).where(eq(teamSkills.id, id));
    return row ? toRecord("team", row) : null;
  }
  const [row] = await tx
    .select()
    .from(installSkills)
    .where(and(eq(installSkills.id, id), eq(installSkills.ownerUserId, location.ownerUserId)));
  return row ? toRecord("personal", row) : null;
}

/** Versions of a skill, newest first; empty if the caller can't see the skill. */
export function listSkillVersions(
  db: KobeDb,
  location: SkillLocation,
  skillId: string,
): Promise<SkillVersionRecord[]> {
  return inLocation(db, location, async (tx) => {
    if (!(await findById(tx, location, skillId))) return [];
    const rows =
      location.scope === "team"
        ? await tx
            .select()
            .from(teamSkillVersions)
            .where(eq(teamSkillVersions.skillId, skillId))
            .orderBy(desc(teamSkillVersions.version))
        : await tx
            .select()
            .from(installSkillVersions)
            .where(eq(installSkillVersions.skillId, skillId))
            .orderBy(desc(installSkillVersions.version));
    return rows.map(toVersion);
  });
}

export function getSkillVersion(
  db: KobeDb,
  location: SkillLocation,
  skillId: string,
  version: number,
): Promise<SkillVersionRecord | null> {
  return inLocation(db, location, async (tx) =>
    (await findById(tx, location, skillId)) ? versionOf(tx, location, skillId, version) : null,
  );
}

async function versionOf(
  tx: KobeTx,
  location: SkillLocation,
  skillId: string,
  version: number,
): Promise<SkillVersionRecord | null> {
  const [row] =
    location.scope === "team"
      ? await tx
          .select()
          .from(teamSkillVersions)
          .where(
            and(eq(teamSkillVersions.skillId, skillId), eq(teamSkillVersions.version, version)),
          )
      : await tx
          .select()
          .from(installSkillVersions)
          .where(
            and(
              eq(installSkillVersions.skillId, skillId),
              eq(installSkillVersions.version, version),
            ),
          );
  return row ? toVersion(row) : null;
}
