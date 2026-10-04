import type { SkillBundleRef } from "@kobe/protocol";
import {
  and,
  eq,
  inArray,
  installSkills,
  sql,
  installSkillVersions,
  teamSkillVersions,
  type KobeTx,
} from "@kobe/db";
import { logger } from "../logger.js";
import type { SkillRef } from "../resolver/resolve.js";
import { blockedAmong, isBlocked } from "./blocklist.js";

/**
 * Skill materialization, server side (KOBE-82, D22). Two read paths, both inside a transaction and
 * both checking the install blocklist again in it:
 *
 * - {@link bundleRefsFor}: the run-start list. The resolver's effective skills (approved, not
 *   blocklisted, not team-disabled) become `{name, sha256, size}` refs in `run.start`; nothing else
 *   is ever listed, so nothing else reaches a sandbox.
 * - {@link locateBundle}: what a sandbox may download: only a hash listed in the `run.start` of a
 *   run active on that sandbox, and never a blocklisted one.
 */

/** Ref list for `run.start` from the resolver's effective skills, blocklist re-checked here. */
export async function bundleRefsFor(
  tx: KobeTx,
  who: { teamId: string; userId: string },
  skills: readonly SkillRef[],
): Promise<SkillBundleRef[]> {
  if (skills.length === 0) return [];
  const hashes = skills.map((s) => s.hash);
  const blocked = new Set(await blockedAmong(tx, hashes));
  const sizes = await sizesByHash(
    tx,
    who,
    hashes.filter((h) => !blocked.has(h)),
  );
  const refs: SkillBundleRef[] = [];
  for (const skill of skills) {
    if (blocked.has(skill.hash)) continue;
    const size = sizes.get(skill.hash);
    if (size === undefined) {
      // A version row can't vanish (immutable, no delete); log rather than start a run without it.
      logger.error({ name: skill.name, hash: skill.hash }, "skills: effective bundle has no row");
      continue;
    }
    refs.push({ name: skill.name, sha256: skill.hash, size });
  }
  return refs;
}

async function sizesByHash(
  tx: KobeTx,
  who: { teamId: string; userId: string },
  hashes: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (hashes.length === 0) return sizes;
  const team = await tx
    .select({ hash: teamSkillVersions.contentHash, size: teamSkillVersions.sizeBytes })
    .from(teamSkillVersions)
    .where(
      and(
        eq(teamSkillVersions.teamId, who.teamId),
        inArray(teamSkillVersions.contentHash, [...hashes]),
      ),
    );
  const personal = await tx
    .select({ hash: installSkillVersions.contentHash, size: installSkillVersions.sizeBytes })
    .from(installSkillVersions)
    .innerJoin(installSkills, eq(installSkills.id, installSkillVersions.skillId))
    .where(
      and(
        eq(installSkills.ownerUserId, who.userId),
        inArray(installSkillVersions.contentHash, [...hashes]),
      ),
    );
  for (const row of [...team, ...personal]) sizes.set(row.hash, row.size);
  return sizes;
}

export interface LocatedBundle {
  readonly storageKey: string;
  readonly size: number;
}

/** The sandbox the request came from, as the verified token names it. */
export interface BundleCaller {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
}

/**
 * The stored bundle behind `hash`, if this sandbox may fetch it now: the hash is in the
 * `skill_bundles` of a `run.start` still open (not yet answered) for a run active on this very
 * sandbox, and it is not blocklisted at this moment. The list was decided at run start (resolver +
 * blocklist, same transaction), so approval changes or a replaced personal skill afterwards do not
 * break the run that was started with it, while a blocklist entry stops a fetch even mid-run.
 */
export async function locateBundle(
  tx: KobeTx,
  who: BundleCaller,
  hash: string,
): Promise<LocatedBundle | null> {
  if (await isBlocked(tx, hash)) return null;
  const bound = await tx.execute(sql`
    SELECT 1
      FROM sandbox_run_leases l
      JOIN runs r ON r.team_id = l.team_id AND r.id = l.run_id
      JOIN sandbox_commands c
        ON c.team_id = l.team_id AND c.run_id = l.run_id AND c.kind = 'run.start'
     WHERE l.team_id = ${who.teamId} AND l.user_id = ${who.userId}
       AND l.sandbox_id = ${who.sandboxId}
       AND r.status IN ('running', 'waiting_approval')
       AND c.user_id = ${who.userId} AND c.status IN ('pending', 'delivered')
       AND c.frame -> 'config' -> 'skill_bundles'
           @> jsonb_build_array(jsonb_build_object('sha256', ${hash}::text))
     LIMIT 1`);
  if (bound.rows.length === 0) return null;
  // The bytes: this team's version with that hash, else one of the caller's own personal versions
  // (versions are immutable, so a replaced skill's old bytes are still there).
  const [team] = await tx
    .select({ key: teamSkillVersions.storageKey, size: teamSkillVersions.sizeBytes })
    .from(teamSkillVersions)
    .where(and(eq(teamSkillVersions.teamId, who.teamId), eq(teamSkillVersions.contentHash, hash)))
    .limit(1);
  if (team) return { storageKey: team.key, size: team.size };
  const [own] = await tx
    .select({ key: installSkillVersions.storageKey, size: installSkillVersions.sizeBytes })
    .from(installSkillVersions)
    .innerJoin(installSkills, eq(installSkills.id, installSkillVersions.skillId))
    .where(
      and(eq(installSkills.ownerUserId, who.userId), eq(installSkillVersions.contentHash, hash)),
    )
    .limit(1);
  return own ? { storageKey: own.key, size: own.size } : null;
}
