import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import {
  pickCatalogVersion,
  type CatalogPin,
  type CatalogVersion,
} from "../resolver/catalog-pins.js";

/**
 * What an install or a member add shows after a retirement (KOBE-340, SK31): "Revoked — choose a
 * version" when nothing in its range can run because of a revoke, "Withdrawn — choose a version"
 * for a pin on a withdrawn version (it keeps working), a banner for a deprecated version or skill
 * (naming its replacement), "suspended" for a rescan's Block. Null when nothing applies.
 */
export interface Retirement {
  readonly kind: "revoked" | "withdrawn" | "deprecated" | "suspended";
  /** The version concerned: the pinned one, or the one that runs. */
  readonly semver: string;
  readonly replacement: { readonly id: string; readonly name: string } | null;
}

export interface SkillStanding {
  readonly status: string;
  readonly replacement: { readonly id: string; readonly name: string } | null;
}

export function retirementOf(
  versions: readonly CatalogVersion[],
  pin: CatalogPin,
  skill: SkillStanding,
): Retirement | null {
  const pinned = versions.find((v) => v.id === pin.versionId);
  const pick = pickCatalogVersion(versions, pin);
  const replacement = skill.replacement;
  if (!pick.ok) {
    if (pick.reason === "revoked" || pick.reason === "suspended")
      return { kind: pick.reason, semver: pinned?.semver ?? "", replacement };
    return null;
  }
  if (pin.pinMode === "pinned" && pinned?.state === "withdrawn")
    return { kind: "withdrawn", semver: pinned.semver, replacement };
  if (pick.version.state === "deprecated" || skill.status === "deprecated")
    return { kind: "deprecated", semver: pick.version.semver, replacement };
  return null;
}

/** The skill's status and replacement (site rows). */
export async function skillStanding(tx: KobeTx | KobeDb, skillId: string): Promise<SkillStanding> {
  const r = await tx.execute<{ status: string; rid: string | null; rname: string | null }>(sql`
    SELECT s.status::text AS status, r.id AS rid, r.name AS rname
      FROM registry_skills s LEFT JOIN registry_skills r ON r.id = s.replacement_id
     WHERE s.id = ${skillId}`);
  const row = r.rows[0];
  return {
    status: row?.status ?? "active",
    replacement: row?.rid && row.rname ? { id: row.rid, name: row.rname } : null,
  };
}
