import { z } from "zod";
import { AGENT_FILE_LIMITS, skillSlugSchema } from "@kobe/agent-file";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  teamSkillReviews,
  teamSkillVersions,
  type KobeTx,
} from "@kobe/db";
import { blockedAmong } from "./blocklist.js";
import { legacySemver } from "./semver.js";

/**
 * Frozen local skill versions (KOBE-318, SK28). Publishing a team agent version records, per
 * named team skill, the exact version it resolved to (`team_agent_versions.skill_manifest`);
 * runs of that version load exactly those versions. A frozen version still has to pass every
 * run-start check (KOBE-313): it is loaded only while the team's review row says `approved` and
 * no rescan suspended it, and the resolver drops a blocklisted hash. One that fails is omitted
 * with its reason, never replaced by another version: only a republish moves it.
 */

export const frozenSkillSchema = z
  .object({
    name: skillSlugSchema,
    skill_id: z.uuid(),
    version: z.number().int().positive(),
  })
  .strict();

/** `skill_manifest` as read back; a manifest that doesn't parse fails the read (fail closed). */
export const skillManifestSchema = z
  .object({ skills: z.array(frozenSkillSchema).max(AGENT_FILE_LIMITS.skills) })
  .strict();

export type FrozenSkill = z.infer<typeof frozenSkillSchema>;
export type SkillManifest = z.infer<typeof skillManifestSchema>;

export const EMPTY_SKILL_MANIFEST: SkillManifest = { skills: [] };

/** What a frozen version is at this run start. */
export type FrozenState = "approved" | "suspended" | "not_approved";

export interface FrozenDetail {
  readonly entry: FrozenSkill;
  readonly state: FrozenState;
  readonly hash: string | null;
  readonly semver: string;
}

const REVIEW = {
  skillId: teamSkillReviews.skillId,
  version: teamSkillReviews.version,
  slug: teamSkillReviews.slug,
  hash: teamSkillReviews.contentHash,
  status: teamSkillReviews.status,
  suspendedAt: teamSkillReviews.suspendedAt,
  semver: teamSkillVersions.semver,
};

const withSemver = and(
  eq(teamSkillVersions.teamId, teamSkillReviews.teamId),
  eq(teamSkillVersions.skillId, teamSkillReviews.skillId),
  eq(teamSkillVersions.version, teamSkillReviews.version),
);

/**
 * The state of each frozen version in the team (inside `withTeam`), in the manifest's order. The
 * review row must be the team's own (`scope = 'team'`) under the frozen name: a missing row, a
 * rejected or pending one is `not_approved`; a suspended one (a rescan turned it Block) is
 * `suspended`. Blocklisting is the resolver's: it drops the hash with its own notice.
 */
export async function frozenStates(
  tx: KobeTx,
  teamId: string,
  entries: readonly FrozenSkill[],
): Promise<FrozenDetail[]> {
  if (entries.length === 0) return [];
  const rows = await tx
    .select(REVIEW)
    .from(teamSkillReviews)
    .leftJoin(teamSkillVersions, withSemver)
    .where(
      and(
        eq(teamSkillReviews.teamId, teamId),
        eq(teamSkillReviews.scope, "team"),
        or(
          ...entries.map((e) =>
            and(eq(teamSkillReviews.skillId, e.skill_id), eq(teamSkillReviews.version, e.version)),
          ),
        ),
      ),
    );
  const byKey = new Map(rows.map((r) => [`${r.skillId}:${r.version}`, r]));
  return entries.map((entry): FrozenDetail => {
    const row = byKey.get(`${entry.skill_id}:${entry.version}`);
    const semver = row?.semver ?? legacySemver(entry.version);
    if (!row || row.slug !== entry.name)
      return { entry, state: "not_approved", hash: null, semver };
    const state: FrozenState = row.suspendedAt
      ? "suspended"
      : row.status === "approved"
        ? "approved"
        : "not_approved";
    return { entry, state, hash: row.hash, semver };
  });
}

/** What a publish would freeze for one name: the pick, and whether it can load right now. */
export interface FreezePick {
  readonly entry: FrozenSkill;
  readonly semver: string;
  /** Approved, not suspended, not blocklisted. */
  readonly valid: boolean;
}

/**
 * Per name (team skills only, inside `withTeam`), the version a publish freezes: the newest
 * valid one (approved, not suspended, hash not blocklisted), so a republish moves off a version a
 * rescan or the blocklist took out. With none valid, the newest approved or suspended version
 * (what an unfrozen run resolves to), so runs keep showing why it is left out. Names with no such
 * version are absent: runs omit them as `not_approved` until a republish after approval.
 */
export async function freezePicks(
  tx: KobeTx,
  teamId: string,
  names: readonly string[],
): Promise<Map<string, FreezePick>> {
  if (names.length === 0) return new Map();
  const rows = await tx
    .select(REVIEW)
    .from(teamSkillReviews)
    .leftJoin(teamSkillVersions, withSemver)
    .where(
      and(
        eq(teamSkillReviews.teamId, teamId),
        eq(teamSkillReviews.scope, "team"),
        or(eq(teamSkillReviews.status, "approved"), isNotNull(teamSkillReviews.suspendedAt)),
        inArray(teamSkillReviews.slug, [...names]),
      ),
    )
    .orderBy(desc(teamSkillReviews.version));
  const blocked = new Set(await blockedAmong(tx, [...new Set(rows.map((r) => r.hash))]));
  const isValid = (r: (typeof rows)[number]) =>
    r.status === "approved" && !r.suspendedAt && !blocked.has(r.hash);
  const picks = new Map<string, FreezePick>();
  for (const name of names) {
    const mine = rows.filter((r) => r.slug === name);
    const row = mine.find(isValid) ?? mine[0];
    if (!row) continue;
    picks.set(name, {
      entry: { name, skill_id: row.skillId, version: row.version },
      semver: row.semver ?? legacySemver(row.version),
      valid: isValid(row),
    });
  }
  return picks;
}
