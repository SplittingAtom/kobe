import type { Readable } from "node:stream";
import type { ScanResult } from "@kobe/skill-scanner";
import {
  and,
  asc,
  eq,
  isNotNull,
  personalSkills,
  personalSkillVersions,
  teamSkillVersions,
  withTeam,
  type KobeDb,
  type KobeTx,
  type SkillSource,
} from "@kobe/db";
import type { BlobStore } from "../retention/blobs.js";
import { openVerified, readVerified } from "./blob-read.js";
import { legacyProblems } from "./hash-checks.js";
import { locateBundle, type BundleCaller } from "./materialize.js";
import { decideReview, type DecideResult } from "./review.js";
import { discardAttemptBundle, putSkillBundle, sha256Hex, skillBundleKey } from "./storage.js";
import {
  findSkill,
  getSkillVersion,
  listSkillVersions,
  uploadSkillVersion,
  type SkillLocation,
  type SkillRecord,
  type SkillVersionRecord,
  type UploadResult,
} from "./store.js";

/**
 * Where skills live (KOBE-310, spec SK29): records in Postgres, bytes in the object store,
 * addressed by hash. Every read of bytes is verified against the hash the record names, so a
 * corrupted object is refused, never served. Bytes are deduplicated by hash within a location
 * (a team, or one user's personal skills): a version whose runtime or package zip is already
 * stored there reuses that object, so the same bytes are written once.
 */
export interface SkillStore {
  /** Stores the package as the next version of its skill (records, bytes, scan, audit). */
  putPackage(location: SkillLocation, input: PutPackageInput): Promise<UploadResult>;
  /**
   * The verified bytes stored under `hash` in `location`: a runtime zip (`content_hash`) or a
   * package zip (`package_hash`). Null when the location has no such hash or the object is gone;
   * throws `IntegrityError` when the stored bytes don't match it.
   */
  getPackage(location: SkillLocation, hash: string): Promise<Uint8Array | null>;
  /** Versions of a skill, newest (highest seq) first; empty if `location` can't see it. */
  listVersions(location: SkillLocation, skillId: string): Promise<SkillVersionRecord[]>;
  /**
   * A version's package as a verified stream, for download and the browser editor: the package
   * zip when it differs from the runtime zip (so `evals/` and `kobe.skill.yaml` survive an edit),
   * else the runtime zip.
   */
  openVersion(
    location: SkillLocation,
    skillId: string,
    version: number | string,
  ): Promise<OpenedVersion | null>;
  /** The runtime zip a sandbox may fetch now (`locateBundle`), as a verified stream. */
  openSandboxBundle(caller: BundleCaller, hash: string): Promise<SandboxBundle>;
  /** A team admin's review decision on a team version (KOBE-80). */
  recordApproval(
    teamId: string,
    at: { skillId: string; version: number },
    decision: { status: "approved" | "rejected"; note: string | null; reviewerId: string },
  ): Promise<DecideResult>;
  /**
   * The packages of a skill's versions with seq in `range` (both ends inclusive, oldest first),
   * for promotion and export (SK19, SK30). Legacy versions (refused by today's path rules) come
   * back without bytes: they are not exportable until re-saved.
   */
  export(
    location: SkillLocation,
    skillId: string,
    range?: { readonly fromSeq?: number; readonly toSeq?: number },
  ): Promise<ExportedVersion[]>;
}

export interface PutPackageInput {
  readonly bundle: {
    readonly name: string;
    readonly description: string;
    readonly frontmatter: Record<string, unknown>;
    /** The runtime zip (canonical, KOBE-309). */
    readonly zip: Uint8Array;
    readonly packageZip: Uint8Array | null;
    readonly packageHash: string;
    readonly fileCount: number;
    readonly uncompressedBytes: number;
  };
  readonly source: SkillSource;
  readonly uploadedBy: string;
  readonly scan: ScanResult;
  readonly semver?: string;
  readonly changelog?: string;
}

export interface OpenedVersion {
  readonly skill: SkillRecord;
  readonly version: SkillVersionRecord;
  readonly body: Readable;
  readonly size: number;
}

export type SandboxBundle =
  | { readonly ok: true; readonly body: Readable; readonly size: number }
  | { readonly ok: false; readonly error: "not_found" | "unavailable" };

export type ExportedVersion =
  | { readonly version: SkillVersionRecord; readonly bytes: Uint8Array }
  | { readonly version: SkillVersionRecord; readonly legacy: readonly string[] };

/** The only implementation: Postgres records, object-store bytes. */
export class PostgresSkillStore implements SkillStore {
  constructor(
    private readonly db: KobeDb,
    private readonly blobs: BlobStore,
  ) {}

  async putPackage(location: SkillLocation, input: PutPackageInput): Promise<UploadResult> {
    const { bundle } = input;
    const contentHash = sha256Hex(bundle.zip);
    const existing = await this.inLocation(location, (tx) =>
      storedKeys(tx, location, contentHash, bundle.packageHash),
    );
    const written: string[] = [];
    const write = async (bytes: Uint8Array, hash: string) => {
      const key = skillBundleKey(this.blobs.prefix, location, hash);
      written.push(key);
      await putSkillBundle(this.blobs, key, bytes);
      return key;
    };
    const discard = () => Promise.all(written.map((k) => discardAttemptBundle(this.blobs, k)));
    try {
      const storageKey = existing.runtime ?? (await write(bundle.zip, contentHash));
      const packageStorageKey = bundle.packageZip
        ? (existing.package ?? (await write(bundle.packageZip, bundle.packageHash)))
        : null;
      const result = await uploadSkillVersion(this.db, location, {
        slug: bundle.name,
        description: bundle.description,
        frontmatter: bundle.frontmatter,
        source: input.source,
        contentHash,
        storageKey,
        packageHash: bundle.packageHash,
        packageStorageKey,
        sizeBytes: bundle.zip.length,
        fileCount: bundle.fileCount,
        uncompressedBytes: bundle.uncompressedBytes,
        uploadedBy: input.uploadedBy,
        scan: input.scan,
        ...(input.semver ? { semver: input.semver } : {}),
        ...(input.changelog ? { changelog: input.changelog } : {}),
      });
      if (!result.ok) await discard();
      return result;
    } catch (err) {
      await discard();
      throw err;
    }
  }

  async getPackage(location: SkillLocation, hash: string): Promise<Uint8Array | null> {
    const found = await this.inLocation(location, (tx) => findByHash(tx, location, hash));
    return found ? readVerified(this.blobs, found.key, hash, found.size) : null;
  }

  listVersions(location: SkillLocation, skillId: string): Promise<SkillVersionRecord[]> {
    return listSkillVersions(this.db, location, skillId);
  }

  async openVersion(
    location: SkillLocation,
    skillId: string,
    ref: number | string,
  ): Promise<OpenedVersion | null> {
    const skill = await findSkill(this.db, location, skillId);
    const version = skill ? await getSkillVersion(this.db, location, skillId, ref) : null;
    if (!skill || !version) return null;
    const opened =
      version.packageStorageKey && version.packageHash
        ? await openVerified(this.blobs, version.packageStorageKey, version.packageHash, null)
        : await openVerified(
            this.blobs,
            version.storageKey,
            version.contentHash,
            version.sizeBytes,
          );
    return opened ? { skill, version, ...opened } : null;
  }

  async openSandboxBundle(caller: BundleCaller, hash: string): Promise<SandboxBundle> {
    const found = await withTeam(this.db, caller.teamId, (tx) => locateBundle(tx, caller, hash));
    if (!found) return { ok: false, error: "not_found" };
    const opened = await openVerified(this.blobs, found.storageKey, hash, found.size);
    return opened ? { ok: true, ...opened } : { ok: false, error: "unavailable" };
  }

  recordApproval(
    teamId: string,
    at: { skillId: string; version: number },
    decision: { status: "approved" | "rejected"; note: string | null; reviewerId: string },
  ): Promise<DecideResult> {
    return decideReview(this.db, teamId, at, decision);
  }

  async export(
    location: SkillLocation,
    skillId: string,
    range: { readonly fromSeq?: number; readonly toSeq?: number } = {},
  ): Promise<ExportedVersion[]> {
    const versions = (await listSkillVersions(this.db, location, skillId))
      .filter((v) => (range.fromSeq ?? 1) <= v.seq && v.seq <= (range.toSeq ?? Infinity))
      .reverse();
    const out: ExportedVersion[] = [];
    for (const version of versions) {
      const legacy = await this.db.transaction((tx) => legacyProblems(tx, version.contentHash));
      if (legacy) {
        out.push({ version, legacy });
        continue;
      }
      // A version stored before KOBE-310 has one zip, the whole (valid) package: its hash is
      // its content hash. Later ones keep the package zip apart when it differs.
      const bytes = version.packageStorageKey
        ? await readVerified(this.blobs, version.packageStorageKey, version.packageHash ?? "", null)
        : await readVerified(
            this.blobs,
            version.storageKey,
            version.contentHash,
            version.sizeBytes,
          );
      if (!bytes) throw new Error(`skills: stored package of ${version.contentHash} is missing`);
      out.push({ version, bytes });
    }
    return out;
  }

  private inLocation<T>(location: SkillLocation, fn: (tx: KobeTx) => Promise<T>): Promise<T> {
    return location.scope === "team"
      ? withTeam(this.db, location.teamId, fn)
      : this.db.transaction(fn);
  }
}

/** Keys already holding these bytes in this location (deduplication by hash). */
async function storedKeys(
  tx: KobeTx,
  location: SkillLocation,
  contentHash: string,
  packageHash: string,
): Promise<{ runtime?: string; package?: string }> {
  const runtime = await findByHash(tx, location, contentHash);
  const pkg = packageHash === contentHash ? null : await findPackageKey(tx, location, packageHash);
  return {
    ...(runtime ? { runtime: runtime.key } : {}),
    ...(pkg ? { package: pkg } : {}),
  };
}

async function findByHash(
  tx: KobeTx,
  location: SkillLocation,
  hash: string,
): Promise<{ key: string; size: number | null } | null> {
  if (location.scope === "team") {
    const [runtime] = await tx
      .select({ key: teamSkillVersions.storageKey, size: teamSkillVersions.sizeBytes })
      .from(teamSkillVersions)
      .where(
        and(eq(teamSkillVersions.teamId, location.teamId), eq(teamSkillVersions.contentHash, hash)),
      )
      .limit(1);
    if (runtime) return runtime;
  } else {
    const [runtime] = await tx
      .select({ key: personalSkillVersions.storageKey, size: personalSkillVersions.sizeBytes })
      .from(personalSkillVersions)
      .innerJoin(personalSkills, eq(personalSkills.id, personalSkillVersions.skillId))
      .where(
        and(
          eq(personalSkills.ownerUserId, location.ownerUserId),
          eq(personalSkillVersions.contentHash, hash),
        ),
      )
      .limit(1);
    if (runtime) return runtime;
  }
  const key = await findPackageKey(tx, location, hash);
  return key ? { key, size: null } : null;
}

async function findPackageKey(
  tx: KobeTx,
  location: SkillLocation,
  hash: string,
): Promise<string | null> {
  if (location.scope === "team") {
    const [row] = await tx
      .select({ key: teamSkillVersions.packageStorageKey })
      .from(teamSkillVersions)
      .where(
        and(
          eq(teamSkillVersions.teamId, location.teamId),
          eq(teamSkillVersions.packageHash, hash),
          isNotNull(teamSkillVersions.packageStorageKey),
        ),
      )
      .orderBy(asc(teamSkillVersions.seq))
      .limit(1);
    return row?.key ?? null;
  }
  const [row] = await tx
    .select({ key: personalSkillVersions.packageStorageKey })
    .from(personalSkillVersions)
    .innerJoin(personalSkills, eq(personalSkills.id, personalSkillVersions.skillId))
    .where(
      and(
        eq(personalSkills.ownerUserId, location.ownerUserId),
        eq(personalSkillVersions.packageHash, hash),
        isNotNull(personalSkillVersions.packageStorageKey),
      ),
    )
    .orderBy(asc(personalSkillVersions.seq))
    .limit(1);
  return row?.key ?? null;
}
