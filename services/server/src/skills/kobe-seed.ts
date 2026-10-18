import { PROVENANCE_API_VERSION, type KobeSkillManifest } from "@kobe/protocol";
import { RULE_SET, type ScanResult } from "@kobe/skill-scanner";
import { SYSTEM_ACTOR, sql, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { BlobStore } from "../retention/blobs.js";
import { readVerified } from "./blob-read.js";
import { queueDefaultSync } from "./default-sync.js";
import { defaultTagId, defaultTargets, lockDefaultSet, majorOf } from "./default-target.js";
import { loadKobePackages, type KobePackage } from "./kobe-packages.js";
import { scanCanonicalZip } from "./review.js";
import { compareSemver } from "./semver.js";
import { putSkillBundle, sha256Hex } from "./storage.js";

/**
 * Kobe's own catalog skills (KOBE-317, SK4): at every server start, the package set the server
 * ships (`kobe-packages.ts`) is published as approved catalog versions, publisher `kobe`, so a
 * fresh install and every upgrade end with the same catalog. Like the gallery seed, it is
 * idempotent and a failure never stops the server from starting.
 *
 * - **No person.** A Kobe version has no submitter or reviewer and its tag, Default sync and the
 *   installs that sync makes name no user (`by_kobe`); the database refuses anything else
 *   (migration 0137). Kobe's audit events are the system's.
 * - **Bytes first.** The runtime zip (what sandboxes fetch) and the package zip are written to the
 *   object store under content-addressed keys, `<prefix>skills/catalog/<sha256>`, before the
 *   version row commits; identical bytes from two replicas land on the same key. A start re-writes
 *   an object that went missing or bad, so a fetch never meets a hole the seed could fill.
 * - **Scanned like an upload.** A package the scanner Blocks is never published (logged).
 * - **Versions only rise.** A package whose bytes the Site already holds is unchanged (another
 *   replica, a restart, a rollback to an older release). A new one must carry a semver above the
 *   skill's newest; one reusing a semver, or lower (an older release starting after a newer one
 *   published), is refused and logged: nothing is overwritten.
 * - **Default once.** A new Kobe skill is tagged Default and an `add` Default sync is queued
 *   (On by default, Track within major in every team, with the KOBE-314 rules: opt-outs, blocks
 *   and name conflicts are skipped). Later starts never re-tag: a Site admin who removed Default
 *   keeps that choice. A new version in the Default's major queues an `add` again, which only
 *   fills teams that miss the install; a new major waits for a Site admin to move Default (SK6).
 *
 * Replicas starting together write each version once: every write takes the exclusive Default-set
 * lock first (the tag and the sync it queues need it anyway, KOBE-314), then the skill's row.
 */

export type KobeSeedAction = "created" | "published" | "unchanged" | "refused" | "failed";
export type KobeSeedRefusal = "scan_block" | "version_reused" | "version_not_newer";

export interface KobeSeedResult {
  readonly name: string;
  readonly semver: string;
  readonly action: KobeSeedAction;
  readonly reason?: KobeSeedRefusal;
}

export interface KobeSeedDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  /** The package set; defaults to the one the server ships. */
  readonly packages?: readonly KobePackage[];
}

/** The object key of a catalog skill's bytes: content-addressed, the same on every replica. */
export function catalogObjectKey(prefix: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("catalog keys: not a SHA-256");
  return `${prefix}skills/catalog/${sha256}`;
}

interface Stored {
  readonly runtimeKey: string;
  readonly runtimeSize: number;
  readonly packageKey: string | null;
}

/** Writes the object unless it is already there with these bytes (verified). */
async function ensureObject(blobs: BlobStore, bytes: Uint8Array, hash: string): Promise<string> {
  const key = catalogObjectKey(blobs.prefix, hash);
  const intact = await readVerified(blobs, key, hash, bytes.length).catch(() => null);
  if (intact === null) await putSkillBundle(blobs, key, bytes);
  return key;
}

async function storeBytes(blobs: BlobStore, p: KobePackage): Promise<Stored> {
  const runtimeHash = sha256Hex(p.bundle.zip);
  const runtimeKey = await ensureObject(blobs, p.bundle.zip, runtimeHash);
  const packageKey = p.bundle.packageZip
    ? await ensureObject(blobs, p.bundle.packageZip, p.bundle.packageHash)
    : null;
  return { runtimeKey, runtimeSize: p.bundle.zip.length, packageKey };
}

/** The scan as a catalog version stores it (KOBE-313: `rulesVersion` names the rule set). */
const scanDocument = (scan: ScanResult) => ({
  verdict: scan.verdict,
  rulesVersion: scan.ruleSetVersion,
  ruleSet: RULE_SET,
  findings: scan.findings.map((f) => ({ ...f })),
  scripts: [...scan.scripts],
  skipped: [...scan.skipped],
});

/**
 * A Kobe version's provenance (docs/skill-package.md "Kobe-published"): what Kobe vouches for,
 * without the promotion fields (no source team, submitter or scorecard: nobody promoted it).
 */
function provenance(p: KobePackage, scan: ScanResult, at: Date) {
  return {
    apiVersion: PROVENANCE_API_VERSION,
    publisher: "kobe",
    name: p.name,
    version: p.semver,
    hashes: { runtime: sha256Hex(p.bundle.zip), package: p.bundle.packageHash },
    scan: {
      scanner: {
        name: "kobe-skill-scanner",
        version: scan.ruleSetVersion,
        rulesVersion: scan.ruleSetVersion,
      },
      verdict: scan.verdict,
      findings: scan.findings.map(({ category, rule, file, line }) => ({
        category,
        rule,
        file,
        line,
      })),
    },
    createdAt: at.toISOString(),
  };
}

interface SkillRow {
  readonly id: string;
  readonly created: boolean;
}

async function lockedSkill(tx: KobeTx, p: KobePackage): Promise<SkillRow> {
  const summary = p.manifest.summary;
  const found = await tx.execute<{ id: string }>(sql`
    SELECT id FROM registry_skills WHERE name = ${p.name} FOR UPDATE`);
  const id = found.rows[0]?.id;
  if (id) return { id, created: false };
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO registry_skills (name, summary, publisher)
    VALUES (${p.name}, ${summary}, 'kobe') RETURNING id`);
  const row = inserted.rows[0];
  if (!row) throw new Error("skills: Kobe skill insert returned no row");
  return { id: row.id, created: true };
}

type Decision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: KobeSeedRefusal }
  | { readonly kind: "publish"; readonly seq: number };

/** What to do with `p` given the skill's versions (read under the skill's row lock). */
async function decide(tx: KobeTx, skillId: string, p: KobePackage): Promise<Decision> {
  const { rows } = await tx.execute<{ semver: string; package_hash: string; seq: number }>(sql`
    SELECT semver, package_hash, seq FROM registry_versions WHERE skill_id = ${skillId}`);
  if (rows.some((r) => r.package_hash === p.bundle.packageHash)) return { kind: "unchanged" };
  if (rows.some((r) => r.semver === p.semver)) return { kind: "refused", reason: "version_reused" };
  const newest = rows.reduce<string | null>(
    (best, r) => (best === null || compareSemver(r.semver, best) > 0 ? r.semver : best),
    null,
  );
  if (newest !== null && compareSemver(p.semver, newest) < 0)
    return { kind: "refused", reason: "version_not_newer" };
  return { kind: "publish", seq: rows.reduce((n, r) => Math.max(n, Number(r.seq)), 0) + 1 };
}

async function insertVersion(
  tx: KobeTx,
  skillId: string,
  p: KobePackage,
  at: { seq: number; scan: ScanResult; stored: Stored; now: Date },
): Promise<string> {
  const manifest: KobeSkillManifest = p.manifest;
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO registry_versions (skill_id, publisher, semver, seq, runtime_hash, package_hash,
      runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
      scan, verdict, state, submitted_at, approved_at)
    VALUES (${skillId}, 'kobe', ${p.semver}, ${at.seq}, ${sha256Hex(p.bundle.zip)},
      ${p.bundle.packageHash}, ${at.stored.runtimeKey}, ${at.stored.runtimeSize},
      ${at.stored.packageKey}, ${JSON.stringify(manifest)}::jsonb,
      ${JSON.stringify(provenance(p, at.scan, at.now))}::jsonb,
      ${JSON.stringify({ publisher: "kobe" })}::jsonb,
      ${JSON.stringify(scanDocument(at.scan))}::jsonb, ${at.scan.verdict}::scan_verdict,
      'approved', ${at.now.toISOString()}::timestamptz, ${at.now.toISOString()}::timestamptz)
    RETURNING id`);
  const row = rows[0];
  if (!row) throw new Error("skills: Kobe version insert returned no row");
  await tx.execute(sql`
    UPDATE registry_skills SET summary = ${p.manifest.summary}, updated_at = now()
    WHERE id = ${skillId} AND summary IS DISTINCT FROM ${p.manifest.summary}`);
  return row.id;
}

/**
 * The Default tag on a new Kobe skill, and an `add` sync: on creation, and on a later version in
 * the Default's current major while the skill is still Default (fills teams that miss it).
 */
async function applyDefault(
  tx: KobeTx,
  skill: SkillRow,
  version: { id: string; semver: string },
): Promise<void> {
  const target = { id: version.id, semver: version.semver, major: majorOf(version.semver) };
  if (skill.created) {
    await tx.execute(sql`
      INSERT INTO registry_skill_tags (skill_id, tag_id, by_kobe)
      VALUES (${skill.id}, ${await defaultTagId(tx)}, true)`);
    await queueDefaultSync(tx, { skillId: skill.id, kind: "add", target, requestedBy: null });
    return;
  }
  const [current] = await defaultTargets(tx, skill.id);
  if (current?.major === target.major)
    await queueDefaultSync(tx, { skillId: skill.id, kind: "add", target, requestedBy: null });
}

/** The Site already holds these bytes as a version of the skill (a restart, another replica). */
async function held(db: KobeDb, p: KobePackage): Promise<boolean> {
  const { rows } = await db.execute(sql`
    SELECT 1 FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
    WHERE s.name = ${p.name} AND v.package_hash = ${p.bundle.packageHash}`);
  return rows.length > 0;
}

async function seedOne(deps: KobeSeedDeps, p: KobePackage): Promise<KobeSeedResult> {
  const base = { name: p.name, semver: p.semver };
  if (await held(deps.db, p)) {
    await storeBytes(deps.blobs, p);
    return { ...base, action: "unchanged" };
  }
  const scan = await scanCanonicalZip(p.bundle.packageZip ?? p.bundle.zip);
  if (scan.verdict === "block") {
    deps.log.error(
      { name: p.name, semver: p.semver, rules: scan.findings.map((f) => f.rule) },
      "skills: a Kobe skill package scans Block; not published",
    );
    return { ...base, action: "refused", reason: "scan_block" };
  }
  // Bytes before records, so a committed version always has its objects (re-checked each start).
  const stored = await storeBytes(deps.blobs, p);
  return deps.db.transaction(async (tx) => {
    await lockDefaultSet(tx, "exclusive");
    const skill = await lockedSkill(tx, p);
    const decision = await decide(tx, skill.id, p);
    if (decision.kind === "unchanged") return { ...base, action: "unchanged" as const };
    if (decision.kind === "refused") {
      deps.log.error(
        { name: p.name, semver: p.semver, reason: decision.reason },
        "skills: a Kobe skill package was refused (raise its version to change its files)",
      );
      return { ...base, action: "refused" as const, reason: decision.reason };
    }
    const now = new Date();
    const versionId = await insertVersion(tx, skill.id, p, {
      seq: decision.seq,
      scan,
      stored,
      now,
    });
    await applyDefault(tx, skill, { id: versionId, semver: p.semver });
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: "skill.kobe.published",
      teamId: null,
      target: {
        skillId: skill.id,
        name: p.name,
        semver: p.semver,
        runtimeHash: sha256Hex(p.bundle.zip),
        created: skill.created,
      },
    });
    return { ...base, action: skill.created ? ("created" as const) : ("published" as const) };
  });
}

/** Publishes the package set; one skill's failure is logged and never stops the others. */
export async function seedKobeSkills(deps: KobeSeedDeps): Promise<KobeSeedResult[]> {
  const packages = deps.packages ?? (await loadKobePackages());
  const results: KobeSeedResult[] = [];
  for (const p of packages) {
    try {
      results.push(await seedOne(deps, p));
    } catch (err) {
      deps.log.error({ err, name: p.name }, "skills: a Kobe skill could not be published");
      results.push({ name: p.name, semver: p.semver, action: "failed" });
    }
  }
  const changed = results.filter((r) => r.action === "created" || r.action === "published");
  if (changed.length > 0)
    deps.log.info(
      { skills: changed.map((r) => `${r.name}@${r.semver}`) },
      "skills: Kobe published",
    );
  return results;
}
