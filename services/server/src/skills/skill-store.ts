import type { Readable } from "node:stream";
import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import { MANIFEST_PATH, MANIFEST_YAML_OPTIONS } from "@kobe/protocol";
import type { ScanResult } from "@kobe/skill-scanner";
import {
  and,
  desc,
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
import { checkStoredZip, hashOutcome } from "./hash-checks.js";
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
  type UploadDraft,
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
   * for promotion and export (SK19, SK30). Legacy versions come back without bytes: they are not
   * exportable until re-saved. A version whose hash was not checked yet is checked here first
   * (never assumed clean). The blocklist is not consulted: callers check `runtimeHash` themselves.
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
  readonly draft?: UploadDraft;
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

/**
 * One exported version. `runtimeHash` is its identity under the package contract (for a version
 * stored before KOBE-310 with `evals/`, not its `contentHash`): promotion and the catalog use it.
 * `legacy` lists why a version can't leave until re-saved: today's path rules, an invalid SKILL.md
 * or `kobe.skill.yaml`, or a manifest whose version is not the version's semver.
 */
export type ExportedVersion =
  | {
      readonly version: SkillVersionRecord;
      readonly runtimeHash: string;
      readonly bytes: Uint8Array;
    }
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
    // Reuse only an object that is still there and still these bytes: re-uploading repairs a
    // version whose object was lost or damaged.
    const intact = async (candidates: readonly Candidate[], hash: string) => {
      for (const c of candidates)
        if ((await readVerified(this.blobs, c.key, hash, c.size).catch(() => null)) !== null)
          return c.key;
      return null;
    };
    try {
      const storageKey =
        (await intact(existing.runtime, contentHash)) ?? (await write(bundle.zip, contentHash));
      const packageStorageKey = bundle.packageZip
        ? ((await intact(existing.package, bundle.packageHash)) ??
          (await write(bundle.packageZip, bundle.packageHash)))
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
        ...(input.draft ? { draft: input.draft } : {}),
      });
      if (!result.ok) await discard();
      return result;
    } catch (err) {
      await discard();
      throw err;
    }
  }

  async getPackage(location: SkillLocation, hash: string): Promise<Uint8Array | null> {
    const candidates = await this.inLocation(location, (tx) => candidatesFor(tx, location, hash));
    let failure: unknown = null;
    for (const c of candidates) {
      try {
        const bytes = await readVerified(this.blobs, c.key, hash, c.size);
        if (bytes) return bytes;
      } catch (err) {
        failure = err;
      }
    }
    if (failure) throw failure;
    return null;
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
    for (const version of versions) out.push(await this.exportOne(version));
    return out;
  }

  private async exportOne(version: SkillVersionRecord): Promise<ExportedVersion> {
    const stored = () =>
      readVerified(this.blobs, version.storageKey, version.contentHash, version.sizeBytes);
    let outcome = await this.db.transaction((tx) => hashOutcome(tx, version.contentHash));
    if (!outcome) {
      const zip = await stored();
      if (!zip) throw new Error(`skills: stored bundle of ${version.contentHash} is missing`);
      outcome = await checkStoredZip(this.db, version.contentHash, zip);
    }
    if (outcome.runtimeHash === null) return { version, legacy: outcome.problems };
    // A version stored before KOBE-310 has one zip, the whole package: its hash is its content
    // hash. Later ones keep the package zip apart when it differs.
    const bytes =
      version.packageStorageKey && version.packageHash
        ? await readVerified(this.blobs, version.packageStorageKey, version.packageHash, null)
        : await stored();
    if (!bytes) throw new Error(`skills: stored package of ${version.contentHash} is missing`);
    const manifest = unzipSync(bytes, { filter: (f) => f.name === MANIFEST_PATH })[MANIFEST_PATH];
    if (manifest && !manifestNumbers(manifest, version.semver))
      return { version, legacy: ["manifest_version_mismatch"] };
    return { version, runtimeHash: outcome.runtimeHash, bytes };
  }

  private inLocation<T>(location: SkillLocation, fn: (tx: KobeTx) => Promise<T>): Promise<T> {
    return location.scope === "team"
      ? withTeam(this.db, location.teamId, fn)
      : this.db.transaction(fn);
  }
}

interface Candidate {
  readonly key: string;
  /** Null for a package zip (its row records only its hash). */
  readonly size: number | null;
}

/** Keys already holding these bytes in this location (deduplication by hash), newest first. */
async function storedKeys(
  tx: KobeTx,
  location: SkillLocation,
  contentHash: string,
  packageHash: string,
): Promise<{ runtime: Candidate[]; package: Candidate[] }> {
  return {
    runtime: await runtimeCandidates(tx, location, contentHash),
    package: packageHash === contentHash ? [] : await packageCandidates(tx, location, packageHash),
  };
}

/** Every distinct key in `location` that should hold the bytes of `hash`, newest first. */
async function candidatesFor(tx: KobeTx, location: SkillLocation, hash: string) {
  return [
    ...(await runtimeCandidates(tx, location, hash)),
    ...(await packageCandidates(tx, location, hash)),
  ];
}

const distinct = (rows: readonly Candidate[]): Candidate[] => {
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.key) && seen.add(r.key));
};

async function runtimeCandidates(
  tx: KobeTx,
  location: SkillLocation,
  hash: string,
): Promise<Candidate[]> {
  const rows =
    location.scope === "team"
      ? await tx
          .select({ key: teamSkillVersions.storageKey, size: teamSkillVersions.sizeBytes })
          .from(teamSkillVersions)
          .where(
            and(
              eq(teamSkillVersions.teamId, location.teamId),
              eq(teamSkillVersions.contentHash, hash),
            ),
          )
          .orderBy(desc(teamSkillVersions.uploadedAt))
      : await tx
          .select({ key: personalSkillVersions.storageKey, size: personalSkillVersions.sizeBytes })
          .from(personalSkillVersions)
          .innerJoin(personalSkills, eq(personalSkills.id, personalSkillVersions.skillId))
          .where(
            and(
              eq(personalSkills.ownerUserId, location.ownerUserId),
              eq(personalSkillVersions.contentHash, hash),
            ),
          )
          .orderBy(desc(personalSkillVersions.uploadedAt));
  return distinct(rows);
}

async function packageCandidates(
  tx: KobeTx,
  location: SkillLocation,
  hash: string,
): Promise<Candidate[]> {
  const rows =
    location.scope === "team"
      ? await tx
          .select({ key: teamSkillVersions.packageStorageKey })
          .from(teamSkillVersions)
          .where(
            and(
              eq(teamSkillVersions.teamId, location.teamId),
              eq(teamSkillVersions.packageHash, hash),
              isNotNull(teamSkillVersions.packageStorageKey),
            ),
          )
          .orderBy(desc(teamSkillVersions.uploadedAt))
      : await tx
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
          .orderBy(desc(personalSkillVersions.uploadedAt));
  return distinct(rows.flatMap((r) => (r.key ? [{ key: r.key, size: null }] : [])));
}

/**
 * Whether a stored (already validated) `kobe.skill.yaml` names `semver`: a version uploaded
 * before KOBE-310 was numbered 0.<n>.0 whatever its manifest said, and such a package can't
 * leave under a number its own manifest contradicts.
 */
function manifestNumbers(bytes: Uint8Array, semver: string): boolean {
  try {
    const value: unknown = parseYaml(new TextDecoder().decode(bytes), MANIFEST_YAML_OPTIONS);
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { version?: unknown }).version === semver
    );
  } catch {
    return false;
  }
}
