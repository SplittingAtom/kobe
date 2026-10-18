import type { ScanResult } from "@kobe/skill-scanner";
import {
  and,
  desc,
  eq,
  sql,
  personalSkills,
  personalSkillVersions,
  teamSkills,
  teamSkillVersions,
  withTeam,
  type KobeDb,
  type KobeTx,
  type SkillAccess,
  type SkillSource,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { MAX_LIVE_SKILLS, MAX_SKILL_VERSIONS } from "./limits.js";
import { isBlocked } from "./blocklist.js";
import { recordPendingReview, recordPersonalScan } from "./review.js";
import { recordUploadHashes } from "./hash-checks.js";
import { legacySemver, nextSemver, parseSemver } from "./semver.js";

/**
 * Skill bundles in the database (KOBE-78). Team skills live in RLS tables and are always touched
 * inside `withTeam`; personal skills live in site-wide tables, where the owner filter below is
 * the only wall between users, so every personal query applies it. Each upload is one immutable
 * version (the database refuses to change or delete it); uploads to a location are serialized by
 * an advisory lock, so version numbers are consecutive and the slug cap holds. Each version also
 * has a semver (KOBE-308, SK14) that must rise with its sequence number (`seq`, the version number).
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
  /** Semver of the latest version (KOBE-308). */
  readonly latestSemver: string;
  /** Access mode of a team skill (KOBE-308, SK27); null for personal skills. */
  readonly access: SkillAccess | null;
  readonly archivedAt: Date | null;
  readonly ownerUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SkillVersionRecord {
  /** The version number; `seq` is the same number under the name catalog versions share. */
  readonly version: number;
  readonly seq: number;
  readonly semver: string;
  readonly changelog: string | null;
  readonly packageHash: string | null;
  readonly frontmatter: Record<string, unknown>;
  readonly source: SkillSource;
  readonly contentHash: string;
  readonly storageKey: string;
  /** The package zip when it differs from the runtime zip (KOBE-310); null otherwise. */
  readonly packageStorageKey: string | null;
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
  /** Runtime hash (KOBE-309) of the runtime zip at `storageKey`. */
  readonly contentHash: string;
  readonly storageKey: string;
  /** Package hash (KOBE-309): of the package zip, or `contentHash` when there is none. */
  readonly packageHash: string;
  readonly packageStorageKey: string | null;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
  readonly uploadedBy: string;
  /** Scanner result for these exact bytes (KOBE-80). */
  readonly scan: ScanResult;
  /** Requested semver; by default the next minor of the latest (0.1.0 for a new skill). */
  readonly semver?: string;
  readonly changelog?: string;
}

export type UploadError =
  | "unchanged"
  | "skill_limit"
  | "version_limit"
  | "blocklisted"
  | "semver_not_increasing"
  | "semver_required"
  | "name_clash";
export type UploadResult =
  | { readonly ok: true; readonly skill: SkillRecord; readonly version: SkillVersionRecord }
  | { readonly ok: false; readonly error: Exclude<UploadError, SemverError> }
  | { readonly ok: false; readonly error: SemverError; readonly latest: string };
type SemverError = "semver_not_increasing" | "semver_required";

function inLocation<T>(db: KobeDb, location: SkillLocation, fn: (tx: KobeTx) => Promise<T>) {
  return location.scope === "team"
    ? withTeam(db, location.teamId, fn)
    : db.transaction((tx) => fn(tx));
}

/** Also the team's skill-name lock (`lockTeamSkillNames`): installs check names under it. */
const lockKey = (l: SkillLocation) =>
  l.scope === "team" ? `kobe.skills.team:${l.teamId}` : `kobe.skills.personal:${l.ownerUserId}`;

type TeamRow = typeof teamSkills.$inferSelect;
type PersonalRow = typeof personalSkills.$inferSelect;

function toRecord(
  scope: SkillScope,
  row: TeamRow | PersonalRow,
  latestSemver: string | null,
): SkillRecord {
  const team = "access" in row ? row : null;
  return {
    id: row.id,
    scope,
    slug: row.slug,
    description: row.description,
    latestVersion: row.latestVersion,
    latestSemver: latestSemver ?? legacySemver(row.latestVersion),
    access: team?.access ?? null,
    archivedAt: team?.archivedAt ?? null,
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
    if (await isBlocked(tx, input.contentHash)) return { ok: false, error: "blocklisted" };
    const existing = await findBySlug(tx, location, input.slug);
    const latest = existing
      ? await versionOf(tx, location, existing.id, existing.latestVersion)
      : null;
    if (existing) {
      // Unchanged = the same package (KOBE-310): an evals-only change is a new version with the
      // same runtime hash. Versions stored before KOBE-310 have no package hash: their bundle was
      // the whole upload, so its content hash stands in.
      if (latest && (latest.packageHash ?? latest.contentHash) === input.packageHash)
        return { ok: false, error: "unchanged" };
      if (existing.latestVersion >= MAX_SKILL_VERSIONS)
        return { ok: false, error: "version_limit" };
    } else if ((await countSkills(tx, location)) >= MAX_LIVE_SKILLS) {
      return { ok: false, error: "skill_limit" };
    } else if (location.scope === "team" && (await installedAs(tx, location.teamId, input.slug))) {
      // SK27 the other way round (review S4): a new team skill never takes the name of a catalog
      // skill the team installed; the team uninstalls it first.
      return { ok: false, error: "name_clash" };
    }
    const semver = nextSemver(latest?.semver ?? null, input.semver);
    if (!semver.ok) {
      const error = semver.reason === "no_default" ? "semver_required" : "semver_not_increasing";
      return { ok: false, error, latest: semver.latest };
    }
    const skill = existing
      ? await bumpSkill(tx, location, existing, input, semver.semver)
      : await insertSkill(tx, location, input, semver.semver);
    const number = skill.latestVersion;
    const version = await insertVersion(tx, location, skill.id, number, {
      ...input,
      semver: semver.semver,
    });
    // The stored zip is its own runtime payload (KOBE-310), and a package zip joins its group.
    await recordUploadHashes(tx, {
      runtimeHash: input.contentHash,
      packageHash: input.packageHash,
    });
    if (location.scope === "team") {
      await recordPendingReview(
        tx,
        {
          teamId: location.teamId,
          skillId: skill.id,
          version: number,
          slug: skill.slug,
          contentHash: input.contentHash,
        },
        input.scan,
      );
    } else {
      await recordPersonalScan(tx, { skillId: skill.id, version: number }, input.scan);
    }
    await recordAudit(tx, {
      action: "skill.uploaded",
      teamId: location.scope === "team" ? location.teamId : null,
      target: {
        skillId: skill.id,
        scope: location.scope,
        slug: skill.slug,
        version: number,
        semver: version.semver,
        bundleHash: input.contentHash,
        bytes: input.sizeBytes,
        files: input.fileCount,
        source: input.source,
        findings: input.scan.findings.length,
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
    const [row] = await selectTeamSkills(tx).where(eq(teamSkills.slug, slug));
    return row ? toRecord("team", row.skill, row.semver) : null;
  }
  const [row] = await selectPersonalSkills(tx).where(
    and(eq(personalSkills.ownerUserId, location.ownerUserId), eq(personalSkills.slug, slug)),
  );
  return row ? toRecord("personal", row.skill, row.semver) : null;
}

/** Whether the team installed a catalog skill named `slug` (RLS: inside `withTeam`). */
async function installedAs(tx: KobeTx, teamId: string, slug: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM team_skill_installs i JOIN registry_skills s ON s.id = i.skill_id
    WHERE i.team_id = ${teamId} AND s.name = ${slug}`);
  return rows.length > 0;
}

/** Team skills with their latest version's semver (RLS: inside `withTeam`). */
const selectTeamSkills = (tx: KobeTx) =>
  tx
    .select({ skill: teamSkills, semver: teamSkillVersions.semver })
    .from(teamSkills)
    .leftJoin(
      teamSkillVersions,
      and(
        eq(teamSkillVersions.teamId, teamSkills.teamId),
        eq(teamSkillVersions.skillId, teamSkills.id),
        eq(teamSkillVersions.version, teamSkills.latestVersion),
      ),
    );

/** Personal skills with their latest version's semver; callers add the owner filter. */
const selectPersonalSkills = (tx: KobeTx) =>
  tx
    .select({ skill: personalSkills, semver: personalSkillVersions.semver })
    .from(personalSkills)
    .leftJoin(
      personalSkillVersions,
      and(
        eq(personalSkillVersions.skillId, personalSkills.id),
        eq(personalSkillVersions.version, personalSkills.latestVersion),
      ),
    );

async function countSkills(tx: KobeTx, location: SkillLocation): Promise<number> {
  const rows =
    location.scope === "team"
      ? await tx.select({ id: teamSkills.id }).from(teamSkills)
      : await tx
          .select({ id: personalSkills.id })
          .from(personalSkills)
          .where(eq(personalSkills.ownerUserId, location.ownerUserId));
  return rows.length;
}

async function insertSkill(
  tx: KobeTx,
  location: SkillLocation,
  input: NewSkillVersion,
  semver: string,
): Promise<SkillRecord> {
  const values = { slug: input.slug, description: input.description };
  const [row] =
    location.scope === "team"
      ? await tx
          .insert(teamSkills)
          .values({ ...values, teamId: location.teamId, ownerUserId: input.uploadedBy })
          .returning()
      : await tx
          .insert(personalSkills)
          .values({ ...values, ownerUserId: location.ownerUserId })
          .returning();
  if (!row) throw new Error("skill insert returned no row");
  return toRecord(location.scope, row, semver);
}

async function bumpSkill(
  tx: KobeTx,
  location: SkillLocation,
  skill: SkillRecord,
  input: NewSkillVersion,
  semver: string,
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
          .update(personalSkills)
          .set(set)
          .where(
            and(
              eq(personalSkills.id, skill.id),
              eq(personalSkills.ownerUserId, location.ownerUserId),
            ),
          )
          .returning();
  if (!row) throw new Error("skill update returned no row");
  return toRecord(location.scope, row, semver);
}

async function insertVersion(
  tx: KobeTx,
  location: SkillLocation,
  skillId: string,
  version: number,
  input: NewSkillVersion & { readonly semver: string },
): Promise<SkillVersionRecord> {
  const values = {
    skillId,
    version,
    seq: version,
    semver: input.semver,
    changelog: input.changelog ?? null,
    frontmatter: input.frontmatter,
    source: input.source,
    contentHash: input.contentHash,
    storageKey: input.storageKey,
    packageHash: input.packageHash,
    packageStorageKey: input.packageStorageKey,
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
      : await tx.insert(personalSkillVersions).values(values).returning();
  if (!row) throw new Error("skill version insert returned no row");
  return toVersion(row);
}

function toVersion(row: typeof personalSkillVersions.$inferSelect): SkillVersionRecord {
  return {
    version: row.version,
    // Never null after migration 0130 (SQL checks); the fallbacks only satisfy the types.
    seq: row.seq ?? row.version,
    semver: row.semver ?? legacySemver(row.version),
    changelog: row.changelog,
    packageHash: row.packageHash,
    frontmatter: row.frontmatter,
    source: row.source,
    contentHash: row.contentHash,
    storageKey: row.storageKey,
    packageStorageKey: row.packageStorageKey,
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
        ? await selectTeamSkills(tx).orderBy(teamSkills.slug)
        : await selectPersonalSkills(tx)
            .where(eq(personalSkills.ownerUserId, location.ownerUserId))
            .orderBy(personalSkills.slug);
    return rows.map((r) => toRecord(location.scope, r.skill, r.semver));
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
    const [row] = await selectTeamSkills(tx).where(eq(teamSkills.id, id));
    return row ? toRecord("team", row.skill, row.semver) : null;
  }
  const [row] = await selectPersonalSkills(tx).where(
    and(eq(personalSkills.id, id), eq(personalSkills.ownerUserId, location.ownerUserId)),
  );
  return row ? toRecord("personal", row.skill, row.semver) : null;
}

/** Versions of a skill, newest (highest seq) first; empty if the caller can't see the skill. */
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
            .orderBy(desc(teamSkillVersions.seq))
        : await tx
            .select()
            .from(personalSkillVersions)
            .where(eq(personalSkillVersions.skillId, skillId))
            .orderBy(desc(personalSkillVersions.seq));
    return rows.map(toVersion);
  });
}

/** A version by its number (seq) or its semver; null if absent or the caller can't see it. */
export function getSkillVersion(
  db: KobeDb,
  location: SkillLocation,
  skillId: string,
  version: number | string,
): Promise<SkillVersionRecord | null> {
  return inLocation(db, location, async (tx) => {
    if (!(await findById(tx, location, skillId))) return null;
    if (typeof version === "number") return versionOf(tx, location, skillId, version);
    return parseSemver(version) ? versionBySemver(tx, location, skillId, version) : null;
  });
}

async function versionBySemver(
  tx: KobeTx,
  location: SkillLocation,
  skillId: string,
  semver: string,
): Promise<SkillVersionRecord | null> {
  const [row] =
    location.scope === "team"
      ? await tx
          .select()
          .from(teamSkillVersions)
          .where(and(eq(teamSkillVersions.skillId, skillId), eq(teamSkillVersions.semver, semver)))
      : await tx
          .select()
          .from(personalSkillVersions)
          .where(
            and(
              eq(personalSkillVersions.skillId, skillId),
              eq(personalSkillVersions.semver, semver),
            ),
          );
  return row ? toVersion(row) : null;
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
          .from(personalSkillVersions)
          .where(
            and(
              eq(personalSkillVersions.skillId, skillId),
              eq(personalSkillVersions.version, version),
            ),
          );
  return row ? toVersion(row) : null;
}
