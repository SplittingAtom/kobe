import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { BlobStore } from "../retention/blobs.js";
import { pickCatalogVersion, type CatalogVersion } from "../resolver/catalog-pins.js";
import { cardScore, type CardScore } from "./catalog-browse.js";
import { diffPackages, readPackage, type PackageDiff } from "./registry/review-diff.js";
import { compareSemver } from "./semver.js";

/**
 * Updates of a team's catalog install (KOBE-337, SK25): the version the install runs now (as the
 * resolver picks it, `pickCatalogVersion`), and every newer approved version with its changelog,
 * its eval delta (authoritative scorecards, numbers only) and whether the install takes it by
 * itself. Track within major takes newer versions of its major only, never a new major; Track
 * latest takes the newest major; a Pinned install takes none. A new major is labelled. The file
 * diff from the running version to one of them is read on demand. Roll back finds the version the
 * install ran before its last change in the team's own audit log.
 */

export interface InstallUpdate {
  readonly versionId: string;
  readonly semver: string;
  readonly changelog: string | null;
  readonly deprecated: boolean;
  /** Another major than the running version. */
  readonly major: boolean;
  /** The install's pin mode takes it without anyone moving the pin. */
  readonly automatic: boolean;
  /** Authoritative-card numbers of this version minus the running version's (null: unknown). */
  readonly evalDelta: {
    readonly passRate: number | null;
    readonly lift: number | null;
  };
  readonly score: CardScore | null;
}

export interface InstallUpdates {
  readonly skillId: string;
  readonly name: string;
  readonly pinMode: "pinned" | "within_major" | "latest";
  /** The version the install's pin points at. */
  readonly pinned: { readonly versionId: string; readonly semver: string };
  /** The version runs load now; null when none can run (revoked, suspended). */
  readonly running: { readonly versionId: string; readonly semver: string } | null;
  /** Newer approved versions, newest first. */
  readonly updates: readonly InstallUpdate[];
  /** The version a Roll back returns to; null when there is none. */
  readonly rollbackTo: string | null;
}

interface VersionRow extends CatalogVersion {
  readonly manifest: Record<string, unknown>;
  readonly authoritativeScorecard: Record<string, unknown> | null;
}

const majorOf = (semver: string) => Number(semver.split(".", 1)[0]);

async function versionsOf(tx: KobeTx, skillId: string): Promise<VersionRow[]> {
  const res = await tx.execute<{
    id: string;
    semver: string;
    seq: number;
    state: string;
    suspended: boolean;
    runtime_hash: string;
    package_hash: string;
    manifest: Record<string, unknown>;
    authoritative_scorecard: Record<string, unknown> | null;
  }>(sql`
    SELECT id, semver, seq, state::text AS state, suspended_at IS NOT NULL AS suspended,
      runtime_hash, package_hash, manifest, authoritative_scorecard
      FROM registry_versions
     WHERE skill_id = ${skillId}
       AND state::text IN ('approved', 'deprecated', 'withdrawn', 'revoked')`);
  return res.rows.map((r) => ({
    id: r.id,
    semver: r.semver,
    seq: Number(r.seq),
    state: r.state,
    suspended: r.suspended,
    runtimeHash: r.runtime_hash,
    packageHash: r.package_hash,
    manifest: r.manifest,
    authoritativeScorecard: r.authoritative_scorecard,
  }));
}

const delta = (a: number | null | undefined, b: number | null | undefined) =>
  typeof a === "number" && typeof b === "number" ? Math.round((a - b) * 1000) / 1000 : null;

/**
 * The version a Roll back returns to: the one the install ran before the change that set its
 * current version, from the team's own audit rows (configured, moved, rolled back).
 */
export async function rollbackTarget(
  tx: KobeTx,
  teamId: string,
  skillId: string,
  current: string,
): Promise<string | null> {
  const res = await tx.execute<{ action: string; target: Record<string, unknown> }>(sql`
    SELECT action, target FROM audit_log
     WHERE team_id = ${teamId} AND target ->> 'skillId' = ${skillId}
       AND action IN ('skill.catalog.configured', 'skill.catalog.pin_moved',
                      'skill.catalog.rolled_back')
     ORDER BY seq DESC LIMIT 50`);
  for (const r of res.rows) {
    const t = r.target;
    const to = r.action === "skill.catalog.configured" ? t.semver : t.to;
    const from =
      r.action === "skill.catalog.configured"
        ? (t.previous as { semver?: unknown } | undefined)?.semver
        : t.from;
    if (to !== current) return null;
    if (typeof from === "string" && from !== current) return from;
  }
  return null;
}

async function installRow(tx: KobeTx, teamId: string, skillId: string) {
  const res = await tx.execute<{
    name: string;
    version_id: string;
    pin_mode: "pinned" | "within_major" | "latest";
  }>(sql`
    SELECT s.name, i.version_id, i.pin_mode::text AS pin_mode
      FROM team_skill_installs i JOIN registry_skills s ON s.id = i.skill_id
     WHERE i.team_id = ${teamId} AND i.skill_id = ${skillId}`);
  return res.rows[0];
}

export async function installUpdates(
  db: KobeDb,
  teamId: string,
  skillId: string,
): Promise<InstallUpdates | null> {
  return withTeam(db, teamId, async (tx) => {
    const install = await installRow(tx, teamId, skillId);
    if (!install) return null;
    const versions = await versionsOf(tx, skillId);
    const pinned = versions.find((v) => v.id === install.version_id);
    if (!pinned) return null;
    const pick = pickCatalogVersion(versions, {
      pinMode: install.pin_mode,
      versionId: install.version_id,
    });
    const running = pick.ok ? (versions.find((v) => v.id === pick.version.id) ?? null) : null;
    const base = running ?? pinned;
    const baseScore = cardScore(base.authoritativeScorecard);
    // What the pin would pick if this version were published: whether it moves there by itself.
    const takes = (v: VersionRow) =>
      install.pin_mode === "latest" ||
      (install.pin_mode === "within_major" && majorOf(v.semver) === majorOf(pinned.semver));
    const updates = versions
      .filter(
        (v) =>
          (v.state === "approved" || v.state === "deprecated") &&
          !v.suspended &&
          compareSemver(v.semver, base.semver) > 0,
      )
      .sort((a, b) => compareSemver(b.semver, a.semver))
      .map((v): InstallUpdate => {
        const score = cardScore(v.authoritativeScorecard);
        return {
          versionId: v.id,
          semver: v.semver,
          changelog: typeof v.manifest.changelog === "string" ? v.manifest.changelog : null,
          deprecated: v.state === "deprecated",
          major: majorOf(v.semver) !== majorOf(base.semver),
          automatic: takes(v),
          evalDelta: {
            passRate: delta(score?.passRate, baseScore?.passRate),
            lift: delta(score?.lift, baseScore?.lift),
          },
          score,
        };
      });
    return {
      skillId,
      name: install.name,
      pinMode: install.pin_mode,
      pinned: { versionId: pinned.id, semver: pinned.semver },
      running: running ? { versionId: running.id, semver: running.semver } : null,
      updates,
      rollbackTo: await rollbackTarget(tx, teamId, skillId, pinned.semver),
    };
  });
}

/**
 * The file diff from the version the install runs now (its pinned one when none can run) to
 * `toSemver` (published versions only).
 */
export async function installDiff(
  db: KobeDb,
  blobs: BlobStore,
  teamId: string,
  skillId: string,
  toSemver: string,
): Promise<PackageDiff | null> {
  const state = await installUpdates(db, teamId, skillId);
  if (!state) return null;
  const fromId = state.running?.versionId ?? state.pinned.versionId;
  const found = await withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{
      id: string;
      semver: string;
      package_hash: string;
      package_storage_key: string | null;
      runtime_hash: string;
      runtime_storage_key: string | null;
      runtime_size_bytes: number | null;
    }>(sql`
      SELECT id, semver, package_hash, package_storage_key, runtime_hash, runtime_storage_key,
             runtime_size_bytes
        FROM registry_versions
       WHERE skill_id = ${skillId} AND (id = ${fromId} OR semver = ${toSemver})
         AND state::text IN ('approved', 'deprecated', 'withdrawn', 'revoked')`);
    const from = res.rows.find((r) => r.id === fromId);
    const to = res.rows.find((r) => r.semver === toSemver);
    return from && to ? { from, to } : null;
  });
  if (!found) return null;
  const pkg = (r: typeof found.from) =>
    readPackage(blobs, {
      packageHash: r.package_hash,
      packageStorageKey: r.package_storage_key,
      runtimeHash: r.runtime_hash,
      runtimeStorageKey: r.runtime_storage_key,
      runtimeSizeBytes: r.runtime_size_bytes,
    });
  const after = await pkg(found.to);
  if (!after) return null;
  return diffPackages(await pkg(found.from), after);
}
