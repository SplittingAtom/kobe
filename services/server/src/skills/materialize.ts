import type { SkillBundleRef } from "@kobe/protocol";
import {
  and,
  eq,
  inArray,
  installSkills,
  installSkillVersions,
  teamSkillReviews,
  teamSkillVersions,
  type KobeTx,
} from "@kobe/db";
import { logger } from "../logger.js";
import type { SkillRef } from "../resolver/resolve.js";
import { blockedAmong, isBlocked } from "./blocklist.js";
import { usablePersonalSkills } from "./review.js";
import { readPersonalSkillsDisabled } from "./settings.js";

/**
 * Skill materialization, server side (KOBE-82, D22). Two read paths, both inside a transaction and
 * both checking the install blocklist again in it:
 *
 * - {@link bundleRefsFor}: the run-start list. The resolver's effective skills (approved, not
 *   blocklisted, not team-disabled) become `{name, sha256, size}` refs in `run.start`; nothing else
 *   is ever listed, so nothing else reaches a sandbox.
 * - {@link locateBundle}: what a sandbox may download. Only a hash that is effective for the
 *   calling (team, user) right now: an approved team version, or one of the user's usable personal
 *   versions while the team has not switched personal skills off; never a blocklisted one.
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

/** The stored bundle behind `hash` if it is effective for this caller now, else null. */
export async function locateBundle(
  tx: KobeTx,
  who: { teamId: string; userId: string },
  hash: string,
): Promise<LocatedBundle | null> {
  if (await isBlocked(tx, hash)) return null;
  const approved = await tx
    .select({ version: teamSkillReviews.version })
    .from(teamSkillReviews)
    .where(
      and(
        eq(teamSkillReviews.teamId, who.teamId),
        eq(teamSkillReviews.scope, "team"),
        eq(teamSkillReviews.status, "approved"),
        eq(teamSkillReviews.contentHash, hash),
      ),
    )
    .limit(1);
  if (approved.length > 0) {
    const [row] = await tx
      .select({ key: teamSkillVersions.storageKey, size: teamSkillVersions.sizeBytes })
      .from(teamSkillVersions)
      .where(and(eq(teamSkillVersions.teamId, who.teamId), eq(teamSkillVersions.contentHash, hash)))
      .limit(1);
    if (row) return { storageKey: row.key, size: row.size };
  }
  if (await readPersonalSkillsDisabled(tx, who.teamId)) return null;
  const usable = await usablePersonalSkills(tx, { ...who, ensureRows: false });
  if (!usable.some((s) => s.hash === hash)) return null;
  const [row] = await tx
    .select({ key: installSkillVersions.storageKey, size: installSkillVersions.sizeBytes })
    .from(installSkillVersions)
    .innerJoin(installSkills, eq(installSkills.id, installSkillVersions.skillId))
    .where(
      and(eq(installSkills.ownerUserId, who.userId), eq(installSkillVersions.contentHash, hash)),
    )
    .limit(1);
  return row ? { storageKey: row.key, size: row.size } : null;
}
