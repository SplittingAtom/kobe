import { sql, type KobeTx } from "@kobe/db";
import { pickCatalogVersion, type CatalogVersion } from "../resolver/catalog-pins.js";
import { blockedAmong } from "./blocklist.js";

/**
 * A catalog skill's published versions as the resolver sees them, and which one an install runs
 * (KOBE-337): shared by the install acts (Move pin, Roll back) and Update available.
 */
export interface PublishedVersion extends CatalogVersion {
  readonly manifest: Record<string, unknown>;
  readonly authoritativeScorecard: Record<string, unknown> | null;
  /** Its runtime or package hash is on the site blocklist: it never loads (review-337 L3). */
  readonly blocklisted: boolean;
}

export async function publishedVersions(tx: KobeTx, skillId: string): Promise<PublishedVersion[]> {
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
  const blocked = new Set(
    await blockedAmong(
      tx,
      res.rows.flatMap((r) => [r.runtime_hash, r.package_hash]),
    ),
  );
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
    blocklisted: blocked.has(r.runtime_hash) || blocked.has(r.package_hash),
  }));
}

/** The version an install with this pin runs, or null when none can. */
export function runningVersion(
  versions: readonly PublishedVersion[],
  pin: { readonly pinMode: "pinned" | "within_major" | "latest"; readonly versionId: string },
): PublishedVersion | null {
  const pick = pickCatalogVersion(versions, pin);
  return pick.ok ? (versions.find((v) => v.id === pick.version.id) ?? null) : null;
}
