import { provenanceSchema } from "@kobe/protocol";
import { skillPackageHashes } from "@kobe/protocol/node";
import { sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAuditAfter } from "../audit/record.js";
import type { BlobStore } from "../retention/blobs.js";
import { blockedAmong } from "./blocklist.js";
import { exportZip, filesOfPackage, type Exported, type ExportFormat } from "./export.js";
import { readPackage } from "./registry/review-diff.js";

/**
 * A catalog version's export (KOBE-345): only a published one (Approved or Deprecated, not
 * suspended, not on the site blocklist), from its stored package, checked against both recorded
 * hashes before anything leaves. `package` (with kobe.skill.yaml and Kobe's provenance.json) is
 * for Site catalog managers; the portable zips for members of a team that hasn't blocked it.
 */
export type CatalogExportResult =
  | { readonly ok: true; readonly exported: Exported }
  | {
      readonly ok: false;
      readonly code: "not_found" | "blocked" | "unavailable" | "too_large";
    };

type Row = {
  id: string;
  skill_id: string;
  name: string;
  semver: string;
  runtime_hash: string;
  package_hash: string;
  runtime_storage_key: string | null;
  runtime_size_bytes: number | null;
  package_storage_key: string | null;
  provenance: unknown;
};

export async function exportCatalogVersion(
  db: KobeDb,
  blobs: BlobStore | null,
  which: { readonly id: string } | { readonly skillId: string; readonly semver: string },
  format: ExportFormat,
  team: string | null,
): Promise<CatalogExportResult> {
  const res = await db.execute<Row>(sql`
    SELECT v.id, v.skill_id, s.name, v.semver, v.runtime_hash, v.package_hash,
           v.runtime_storage_key, v.runtime_size_bytes, v.package_storage_key, v.provenance
      FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
     WHERE v.state IN ('approved', 'deprecated') AND v.suspended_at IS NULL
       AND ${"id" in which ? sql`v.id = ${which.id}` : sql`v.skill_id = ${which.skillId} AND v.semver = ${which.semver}`}`);
  const v = res.rows[0];
  if (!v) return { ok: false, code: "not_found" };
  const blocked = await db.transaction((tx) => blockedAmong(tx, [v.runtime_hash, v.package_hash]));
  if (blocked.length > 0) return { ok: false, code: "blocked" };
  if (team) {
    const teamBlock = await withTeam(db, team, (tx) =>
      tx.execute(sql`
        SELECT 1 FROM team_skill_blocks WHERE team_id = ${team} AND skill_id = ${v.skill_id}`),
    );
    if (teamBlock.rows.length > 0) return { ok: false, code: "blocked" };
  }
  if (!blobs) return { ok: false, code: "unavailable" };
  const zip = await readPackage(blobs, {
    packageHash: v.package_hash,
    packageStorageKey: v.package_storage_key,
    runtimeHash: v.runtime_hash,
    runtimeStorageKey: v.runtime_storage_key,
    runtimeSizeBytes: v.runtime_size_bytes,
  }).catch(() => null);
  if (!zip) return { ok: false, code: "unavailable" };
  let files: Map<string, Uint8Array>;
  try {
    files = filesOfPackage(zip);
  } catch {
    return { ok: false, code: "too_large" };
  }
  // Exactly the reviewed package: its files hash to what the version records.
  const hashes = (() => {
    try {
      return skillPackageHashes(files);
    } catch {
      return null;
    }
  })();
  if (hashes?.runtimeHash !== v.runtime_hash || hashes.packageHash !== v.package_hash)
    return { ok: false, code: "unavailable" };
  const provenance = provenanceSchema.safeParse(v.provenance);
  const exported = exportZip(
    v.name,
    v.semver,
    files,
    format,
    provenance.success ? provenance.data : null,
  );
  await recordAuditAfter(db, {
    action: "skill.exported",
    teamId: null,
    target: {
      scope: "catalog",
      skillId: v.skill_id,
      registryVersionId: v.id,
      name: v.name,
      semver: v.semver,
      format,
      sha256: exported.sha256,
    },
  });
  return { ok: true, exported };
}
