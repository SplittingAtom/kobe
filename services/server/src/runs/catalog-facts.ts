import { sql, type KobeTx } from "@kobe/db";
import { PUBLISHED_VERSION_STATES } from "@kobe/protocol";
import {
  pickCatalogVersion,
  type CatalogPin,
  type CatalogVersion,
} from "../resolver/catalog-pins.js";
import type { SkillOmission, SkillRef } from "../resolver/resolve.js";
import { defaultTargets, majorOf } from "../skills/default-target.js";
import { readCatalogSwitches } from "../skills/settings.js";

/**
 * Run-start inputs from the Site Skills Catalog (KOBE-315, SK25, SK27), inside `withTeam()`: the
 * team's installs (pin mode, access), this member's enablements (turning installs on or off, and
 * their own adds) and the published versions of those skills. Each install or add becomes a ref at
 * the version its pin selects ({@link pickCatalogVersion}); one whose pin selects nothing runnable
 * becomes an omission (`revoked`, `suspended`, `not_approved`).
 *
 * Team gates (SK25, review S1), read here because this is where a run's skill set is decided:
 * - a catalog skill the team blocked loads neither as an install nor as a member add, whatever
 *   rows other writers left behind (an agent naming it gets `not_installed`);
 * - a member add loads only while the team setting "Members may add catalog skills for
 *   themselves" is on, and never for a skill the team installed Hidden (Hidden means "only for
 *   agents that name it"). An add that doesn't load is ignored as if it weren't there.
 *
 * Kobe's own skills (KOBE-317, the former built-ins) never pause on an upgrade: an agent naming one
 * in a team the Default sync has not reached yet (or that it skipped for a name conflict) gets it
 * as the Default install will be, On by default at Track within major, provided the skill is
 * still Default and the team neither opted out nor blocked it. That is what the built-in gave the
 * same run before the upgrade.
 */
export interface CatalogFacts {
  /** Step 2: catalog skills the agent names, at the team install's pin. */
  readonly named: readonly SkillRef[];
  readonly namedOmissions: readonly SkillOmission[];
  /** Step 1: Required installs. */
  readonly required: readonly SkillRef[];
  readonly requiredOmissions: readonly SkillOmission[];
  /** Step 3: On by default installs not turned off, Available ones turned on, member adds. */
  readonly offered: readonly SkillRef[];
  readonly offeredOmissions: readonly SkillOmission[];
}

type SkillInstallRow = {
  readonly skill_id: string;
  readonly name: string;
  readonly version_id: string;
  readonly pin_mode: CatalogPin["pinMode"];
  readonly access: "available" | "default_on" | "required" | "hidden";
};

type EnablementRow = {
  readonly skill_id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly version_id: string | null;
  readonly pin_mode: CatalogPin["pinMode"] | null;
};

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

async function versionsOf(
  tx: KobeTx,
  skillIds: readonly string[],
): Promise<Map<string, CatalogVersion[]>> {
  const out = new Map<string, CatalogVersion[]>();
  if (skillIds.length === 0) return out;
  const { rows } = await tx.execute<{
    id: string;
    skill_id: string;
    semver: string;
    seq: number;
    state: string;
    suspended: boolean;
    runtime_hash: string;
    package_hash: string;
  }>(sql`
    SELECT id, skill_id, semver, seq, state::text AS state, suspended_at IS NOT NULL AS suspended,
      runtime_hash, package_hash
    FROM registry_versions
    WHERE skill_id IN (${sql.join(
      skillIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND state::text IN (${sql.join(
        PUBLISHED_VERSION_STATES.map((st) => sql`${st}`),
        sql`, `,
      )})`);
  for (const r of rows) {
    const list = out.get(r.skill_id) ?? [];
    list.push({
      id: r.id,
      semver: r.semver,
      seq: Number(r.seq),
      state: r.state,
      suspended: r.suspended,
      runtimeHash: r.runtime_hash,
      packageHash: r.package_hash,
    });
    out.set(r.skill_id, list);
  }
  return out;
}

/**
 * Named Kobe skills the team has no install of yet, as their Default install would be (see the
 * header): skill id and the Default's major, for those still tagged Default and neither opted out
 * nor blocked in this team.
 */
async function pendingKobeDefaults(
  tx: KobeTx,
  teamId: string,
  names: readonly string[],
): Promise<Map<string, { skillId: string; major: number }>> {
  const out = new Map<string, { skillId: string; major: number }>();
  if (names.length === 0) return out;
  const { rows } = await tx.execute<{ id: string; name: string }>(sql`
    SELECT s.id, s.name FROM registry_skills s
    WHERE s.publisher = 'kobe' AND s.name IN (${sql.join(
      names.map((n) => sql`${n}`),
      sql`, `,
    )})
      AND EXISTS (SELECT 1 FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
        WHERE st.skill_id = s.id AND t.kind = 'system' AND t.name = 'default')
      AND NOT EXISTS (SELECT 1 FROM team_skill_optouts o
        WHERE o.team_id = ${teamId} AND o.skill_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM team_skill_blocks b
        WHERE b.team_id = ${teamId} AND b.skill_id = s.id)`);
  for (const r of rows) {
    const [target] = await defaultTargets(tx, r.id);
    if (target) out.set(r.name, { skillId: r.id, major: target.major });
  }
  return out;
}

export async function loadCatalogFacts(
  tx: KobeTx,
  args: {
    readonly teamId: string;
    readonly userId: string;
    /** Names the agent lists that are not built-ins or team skills (those resolve locally). */
    readonly namedCatalog: readonly string[];
  },
): Promise<CatalogFacts> {
  const notBlocked = (skill: ReturnType<typeof sql>) => sql`NOT EXISTS (
    SELECT 1 FROM team_skill_blocks b WHERE b.team_id = ${args.teamId} AND b.skill_id = ${skill})`;
  const installs = (
    await tx.execute<SkillInstallRow>(sql`
      SELECT i.skill_id, s.name, i.version_id, i.pin_mode::text AS pin_mode, i.access::text AS access
      FROM team_skill_installs i JOIN registry_skills s ON s.id = i.skill_id
      WHERE i.team_id = ${args.teamId} AND ${notBlocked(sql`i.skill_id`)}`)
  ).rows;
  const { membersMayAdd } = await readCatalogSwitches(tx, args.teamId);
  const hidden = new Set(installs.filter((i) => i.access === "hidden").map((i) => i.skill_id));
  const enablements = (
    await tx.execute<EnablementRow>(sql`
      SELECT e.catalog_skill_id AS skill_id, s.name, e.enabled, e.version_id,
        e.pin_mode::text AS pin_mode
      FROM member_skill_enablements e JOIN registry_skills s ON s.id = e.catalog_skill_id
      WHERE e.team_id = ${args.teamId} AND e.user_id = ${args.userId}
        AND e.catalog_skill_id IS NOT NULL AND ${notBlocked(sql`e.catalog_skill_id`)}`)
  ).rows.filter((e) => e.version_id === null || (membersMayAdd && !hidden.has(e.skill_id)));
  const installedNames = new Set(installs.map((i) => i.name));
  const pending = await pendingKobeDefaults(
    tx,
    args.teamId,
    args.namedCatalog.filter((n) => !installedNames.has(n)),
  );
  const versions = await versionsOf(tx, [
    ...new Set([
      ...installs.map((i) => i.skill_id),
      ...enablements.map((e) => e.skill_id),
      ...[...pending.values()].map((p) => p.skillId),
    ]),
  ]);

  const resolve = (skillId: string, name: string, pin: CatalogPin) => {
    const pick = pickCatalogVersion(versions.get(skillId) ?? [], pin);
    if (!pick.ok) return { omission: { name, reason: pick.reason } satisfies SkillOmission };
    const v = pick.version;
    const ref: SkillRef = {
      name,
      hash: v.runtimeHash,
      source: "catalog",
      semver: v.semver,
      ...(v.packageHash !== v.runtimeHash ? { aliases: [v.packageHash] } : {}),
    };
    return { ref };
  };
  const out = {
    named: [] as SkillRef[],
    namedOmissions: [] as SkillOmission[],
    required: [] as SkillRef[],
    requiredOmissions: [] as SkillOmission[],
    offered: [] as SkillRef[],
    offeredOmissions: [] as SkillOmission[],
  };
  const into = (
    refs: SkillRef[],
    omissions: SkillOmission[],
    r: { ref?: SkillRef; omission?: SkillOmission },
  ) => {
    if (r.ref) refs.push(r.ref);
    if (r.omission) omissions.push(r.omission);
  };
  const installed = new Map(installs.map((i) => [i.name, i]));
  const pinOf = (i: SkillInstallRow): CatalogPin => ({
    pinMode: i.pin_mode,
    versionId: i.version_id,
  });

  // Step 2: the agent's catalog names at the team's pin (a member add is not an install).
  const named = new Set(args.namedCatalog);
  for (const name of named) {
    const i = installed.get(name);
    const kobe = pending.get(name);
    // Any version of the Default's major anchors Track within major (the pin picks the newest).
    const anchor = kobe
      ? (versions.get(kobe.skillId) ?? []).find((v) => majorOf(v.semver) === kobe.major)
      : undefined;
    if (i) into(out.named, out.namedOmissions, resolve(i.skill_id, i.name, pinOf(i)));
    else if (kobe && anchor)
      into(
        out.named,
        out.namedOmissions,
        resolve(kobe.skillId, name, { pinMode: "within_major", versionId: anchor.id }),
      );
    else out.namedOmissions.push({ name, reason: "not_installed" });
  }

  // Steps 1 and 3, by name so a full run leaves out the same skills each time.
  const choice = new Map(enablements.map((e) => [e.skill_id, e]));
  for (const i of [...installs].sort(byName)) {
    const mine = choice.get(i.skill_id);
    if (i.access === "required") {
      into(out.required, out.requiredOmissions, resolve(i.skill_id, i.name, pinOf(i)));
      continue;
    }
    // A member add (own version and pin) of an installed skill is handled with the adds below.
    if (mine?.version_id) continue;
    const on =
      (i.access === "default_on" && mine?.enabled !== false) ||
      (i.access === "available" && mine?.enabled === true);
    if (on && !named.has(i.name))
      into(out.offered, out.offeredOmissions, resolve(i.skill_id, i.name, pinOf(i)));
  }
  for (const e of [...enablements].sort(byName)) {
    if (!e.enabled || !e.version_id || !e.pin_mode) continue;
    if (installed.get(e.name)?.access === "required" || named.has(e.name)) continue;
    into(
      out.offered,
      out.offeredOmissions,
      resolve(e.skill_id, e.name, { pinMode: e.pin_mode, versionId: e.version_id }),
    );
  }
  return out;
}
