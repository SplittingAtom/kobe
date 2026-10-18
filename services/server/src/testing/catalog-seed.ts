import { createHash } from "node:crypto";
import type pg from "pg";
import { must } from "./event-stream-fixture.js";

/**
 * Seeds team skills, catalog skills, installs and personal skills straight into the database
 * (KOBE-315 tests): rows as the routes would leave them, without the upload and review flows.
 */
export const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

export function catalogSeed(admin: () => pg.Client) {
  /** A team skill; `addVersion` adds approved versions (semver 0.<n>.0). */
  async function teamSkill(team: string, ownerId: string, slug: string, access = "available") {
    const { rows } = await admin().query<{ id: string }>(
      `INSERT INTO team_skills (team_id, owner_user_id, slug, description, latest_version, access,
         offer_to_all)
       VALUES ($1, $2, $3, 'd', 1, $4::skill_access, $5) RETURNING id`,
      [team, ownerId, slug, access, access === "default_on"],
    );
    return must(rows[0], "skill").id;
  }

  async function addVersion(
    team: string,
    ownerId: string,
    skillId: string,
    slug: string,
    n: number,
  ) {
    const hash = hashOf(`${team}:${slug}:${n}`);
    await admin().query(
      `INSERT INTO team_skill_versions (team_id, skill_id, version, frontmatter, source, content_hash,
         storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by, semver, seq)
       VALUES ($1, $2, $3, '{}', 'zip', $4, 'k', 1, 1, 1, $5, '0.' || $3::int || '.0', $3::int)`,
      [team, skillId, n, hash, ownerId],
    );
    await admin().query(
      `INSERT INTO team_skill_reviews (team_id, skill_id, version, scope, slug, content_hash, status,
         flagged, findings, scripts, skipped, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 'team', $4, $5, 'approved', false, '[]', '[]', '[]', $6, now())`,
      [team, skillId, n, slug, hash, ownerId],
    );
    await admin().query(
      `UPDATE team_skills SET latest_version = $3 WHERE team_id = $1 AND id = $2`,
      [team, skillId, n],
    );
    return hash;
  }

  /** A catalog skill with published versions `[semver, state, suspended?]`; returns ids by semver. */
  async function catalogSkill(
    name: string,
    submitter: string,
    reviewer: string,
    versions: readonly (readonly [string, string, boolean?])[],
  ) {
    const skill = must(
      (
        await admin().query<{ id: string }>(
          `INSERT INTO registry_skills (name, summary) VALUES ($1, 'S.') RETURNING id`,
          [name],
        )
      ).rows[0],
      "catalog skill",
    ).id;
    const ids: Record<string, string> = {};
    for (const [i, [semver, state, suspended]] of versions.entries()) {
      const published = ["approved", "deprecated", "withdrawn", "revoked"].includes(state);
      const r = await admin().query<{ id: string }>(
        `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
           provenance, source, scan, verdict, state, submitted_by, reviewed_by, approved_at,
           suspended_at)
         VALUES ($1, $2, $3, $4, $5, '{}', '{}', '{}', '{}', 'pass', $6, $7, $8, $9, $10) RETURNING id`,
        [
          skill,
          semver,
          i + 1,
          hashOf(`${name}@${semver}:runtime`),
          hashOf(`${name}@${semver}:package`),
          state,
          submitter,
          published ? reviewer : null,
          published ? new Date() : null,
          suspended ? new Date() : null,
        ],
      );
      ids[semver] = must(r.rows[0], "version").id;
    }
    return { skill, ids };
  }

  async function install(
    team: string,
    by: string,
    c: { skill: string; ids: Record<string, string> },
    semver: string,
    pinMode: string,
    access: string,
  ) {
    await admin().query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [team, c.skill, c.ids[semver], pinMode, access, by],
    );
  }

  /** A personal skill with one version and a Pass scan (no team review needed). */
  async function personalSkill(userId: string, slug: string) {
    const { rows } = await admin().query<{ id: string }>(
      `INSERT INTO personal_skills (owner_user_id, slug, description) VALUES ($1, $2, 'd') RETURNING id`,
      [userId, slug],
    );
    const id = must(rows[0], "personal skill").id;
    const hash = hashOf(`${userId}:${slug}:personal`);
    await admin().query(
      `INSERT INTO personal_skill_versions (skill_id, version, frontmatter, source, content_hash,
         storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by, semver, seq)
       VALUES ($1, 1, '{}', 'zip', $2, 'k', 1, 1, 1, $3, '0.1.0', 1)`,
      [id, hash, userId],
    );
    await admin().query(
      `INSERT INTO personal_skill_scans (skill_id, version, flagged, findings, scripts, skipped)
       VALUES ($1, 1, false, '[]', '[]', '[]')`,
      [id],
    );
    return { id, hash };
  }

  return { teamSkill, addVersion, catalogSkill, install, personalSkill };
}
