import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { siteRoleAllows, type SiteRole } from "../../authz/permissions.js";
import type { CatalogVersion } from "../../resolver/catalog-pins.js";
import { addBlockedInTx, blockEntryOf, removeBlockEntryInTx } from "../blocklist.js";
import { inRegistryTx } from "./registry-tx.js";

/**
 * Deprecate → Withdraw → Revoke (KOBE-340, SK31), and Unrevoke:
 *
 * | Action | Who | From | Effect |
 * |---|---|---|---|
 * | deprecate (version) | an active maintainer or a Site admin | approved | new installs need a Team admin's override with a warning; members can't add it; existing pins and tracking keep it with a banner |
 * | deprecate (skill) | the same | active or unmaintained | the same for every version, naming a replacement or not |
 * | withdraw | Site admin | approved, deprecated | no new installs, adds or pins; pinned installs keep it ("Withdrawn — choose a version"); tracking moves to the next highest in range (the resolver, `pickCatalogVersion`) |
 * | revoke | Site admin | approved, deprecated, withdrawn | the runtime hash goes on the blocklist: no run starts with it and no sandbox fetches it any more, in every team (the next fetch stops); tracking moves within range only if a version is left there |
 * | unrevoke | Site admin | revoked | back to the state it left; the blocklist entry its revoke added is lifted |
 *
 * Never a move across majors (the resolver's ranges). Each act is a review event and a site audit
 * row in one transaction; notices follow (`retire-notify.ts`).
 */
export type VersionAct = "deprecate" | "undeprecate" | "withdraw" | "revoke" | "unrevoke";

const FROM: Readonly<Record<VersionAct, readonly string[]>> = {
  deprecate: ["approved"],
  undeprecate: ["deprecated"],
  withdraw: ["approved", "deprecated"],
  revoke: ["approved", "deprecated", "withdrawn"],
  unrevoke: ["revoked"],
};
const EVENT = {
  deprecate: "deprecated",
  undeprecate: "undeprecated",
  withdraw: "withdrawn",
  revoke: "revoked",
  unrevoke: "unrevoked",
} as const;
/** The state each act leaves (Unrevoke: the one its revoke left, read from the event). */
const TO: Readonly<Record<VersionAct, string>> = {
  deprecate: "deprecated",
  undeprecate: "approved",
  withdraw: "withdrawn",
  revoke: "revoked",
  unrevoke: "approved",
};

export interface Actor {
  readonly userId: string;
  readonly siteRole: SiteRole;
}

export type RetireRefusal = "not_found" | "forbidden" | "wrong_state" | "bad_replacement";

export interface Retired {
  readonly skillId: string;
  readonly name: string;
  /** Null for a whole skill's deprecation. */
  readonly semver: string | null;
  readonly versionId: string | null;
  readonly act: VersionAct;
  readonly state: string;
  /** The skill's versions as they were before the act (who was running what). */
  readonly before: readonly CatalogVersion[];
  /**
   * Other versions of the skill with the same runtime hash (review L3): a revoke's blocklist entry
   * stops them too, so their installs are told as well.
   */
  readonly siblingIds: readonly string[];
  /** Unrevoke: when the revoke it undoes happened (its notices name the people to tell again). */
  readonly revokedAt: string | null;
}

export type RetireResult =
  | { readonly ok: true; readonly retired: Retired }
  | { readonly ok: false; readonly code: RetireRefusal };

async function isActiveMaintainer(tx: KobeTx, skillId: string, userId: string) {
  const r = await tx.execute(sql`
    SELECT 1 FROM registry_maintainers m JOIN users u ON u.id = m.user_id
     WHERE m.skill_id = ${skillId} AND m.user_id = ${userId} AND u.deactivated_at IS NULL`);
  return r.rows.length > 0;
}

/**
 * A maintainer or Site admin may deprecate and undo it; only Site admins withdraw, revoke and
 * unrevoke.
 */
async function mayAct(tx: KobeTx, act: VersionAct, skillId: string, who: Actor) {
  if (siteRoleAllows(who.siteRole, "site.skills.catalog.manage")) return true;
  return (
    (act === "deprecate" || act === "undeprecate") &&
    (await isActiveMaintainer(tx, skillId, who.userId))
  );
}

async function versionsBefore(tx: KobeTx, skillId: string): Promise<CatalogVersion[]> {
  const r = await tx.execute<{
    id: string;
    semver: string;
    seq: number;
    state: string;
    suspended: boolean;
    runtime_hash: string;
    package_hash: string;
  }>(sql`
    SELECT id, semver, seq, state::text AS state, suspended_at IS NOT NULL AS suspended,
      runtime_hash, package_hash
      FROM registry_versions
     WHERE skill_id = ${skillId}
       AND state::text IN ('approved', 'deprecated', 'withdrawn', 'revoked')`);
  return r.rows.map((v) => ({
    id: v.id,
    semver: v.semver,
    seq: Number(v.seq),
    state: v.state,
    suspended: v.suspended,
    runtimeHash: v.runtime_hash,
    packageHash: v.package_hash,
  }));
}

/** One version's act, in one transaction (the version row locked). */
export function retireVersion(
  db: KobeDb,
  input: {
    readonly skillId: string;
    readonly semver: string;
    readonly act: VersionAct;
    readonly actor: Actor;
    readonly note?: string | undefined;
  },
): Promise<RetireResult> {
  const { skillId, act, actor } = input;
  return inRegistryTx(db, async (tx): Promise<RetireResult> => {
    const found = await tx.execute<{
      id: string;
      name: string;
      state: string;
      runtime_hash: string;
    }>(sql`
      SELECT v.id, s.name, v.state::text AS state, v.runtime_hash
        FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
       WHERE v.skill_id = ${skillId} AND v.semver = ${input.semver}
         AND v.state::text IN ('approved', 'deprecated', 'withdrawn', 'revoked')
       FOR UPDATE OF v`);
    const v = found.rows[0];
    if (!v) return { ok: false, code: "not_found" };
    if (!(await mayAct(tx, act, skillId, actor))) return { ok: false, code: "forbidden" };
    if (!FROM[act].includes(v.state)) return { ok: false, code: "wrong_state" };
    const before = await versionsBefore(tx, skillId);
    const siblingIds = before
      .filter((x) => x.id !== v.id && x.runtimeHash === v.runtime_hash)
      .map((x) => x.id);
    let revokedAt: string | null = null;
    let to: string = TO[act];
    const admin = siteRoleAllows(actor.siteRole, "site.skills.catalog.manage");
    // A maintainer doesn't undo a Site admin's deprecation (review-341 L4).
    if (act === "undeprecate" && !admin) {
      const last = await tx.execute<{ by_admin: boolean | null }>(sql`
        SELECT (checklist ->> 'byAdmin')::boolean AS by_admin FROM registry_review_events
         WHERE version_id = ${v.id} AND action = 'deprecated' ORDER BY id DESC LIMIT 1`);
      if (last.rows[0]?.by_admin === true) return { ok: false, code: "forbidden" };
    }
    let checklist: Record<string, unknown> = {
      from: v.state,
      ...(act === "deprecate" ? { byAdmin: admin } : {}),
    };
    const target = { registryVersionId: v.id, skillId, name: v.name, semver: input.semver };
    if (act === "revoke") {
      const added = await addBlockedInTx(tx, {
        hash: v.runtime_hash,
        reason: `Revoked: ${v.name} ${input.semver}${input.note ? `. ${input.note}` : ""}`.slice(
          0,
          500,
        ),
        userId: actor.userId,
      });
      // Which entry this revoke added (review L2): Unrevoke lifts exactly that one.
      const addedAt = added ? await blockEntryOf(tx, v.runtime_hash) : null;
      checklist = { ...checklist, blocklisted: added !== null, ...(addedAt ? { addedAt } : {}) };
    }
    if (act === "unrevoke") {
      // The state the revoke left, and whether that revoke put the hash on the blocklist.
      const last = await tx.execute<{
        checklist: { from?: string; blocklisted?: boolean; addedAt?: string };
        at: string;
      }>(sql`
        SELECT checklist, at::text AS at FROM registry_review_events
         WHERE version_id = ${v.id} AND action = 'revoked' ORDER BY id DESC LIMIT 1`);
      const prior = last.rows[0]?.checklist ?? {};
      revokedAt = last.rows[0]?.at ?? null;
      to = prior.from && FROM.revoke.includes(prior.from) ? prior.from : "approved";
      // Only the entry the revoke added, while it is still that entry (review L2).
      const unblocked =
        prior.blocklisted === true &&
        prior.addedAt !== undefined &&
        (await removeBlockEntryInTx(tx, { hash: v.runtime_hash, addedAt: prior.addedAt }));
      const blockReplaced = prior.blocklisted === true && !unblocked;
      checklist = { to, unblocked, ...(blockReplaced ? { blockReplaced } : {}) };
    }
    await tx.execute(sql`
      UPDATE registry_versions SET state = ${to}::registry_version_state, updated_at = now()
       WHERE id = ${v.id}`);
    await tx.execute(sql`
      INSERT INTO registry_review_events (version_id, actor_id, action, note, checklist)
      VALUES (${v.id}, ${actor.userId}, ${EVENT[act]}::registry_review_action,
        ${input.note ?? null}, ${JSON.stringify(checklist)}::jsonb)`);
    await tx.execute(sql`UPDATE registry_skills SET updated_at = now() WHERE id = ${skillId}`);
    if (act === "revoke")
      await recordAudit(tx, {
        action: "registry.revoked",
        target: { ...target, from: v.state, blocklisted: checklist.blocklisted === true },
      });
    else if (act === "unrevoke")
      await recordAudit(tx, {
        action: "registry.unrevoked",
        target: {
          ...target,
          to,
          unblocked: checklist.unblocked === true,
          ...(checklist.blockReplaced === true ? { blockReplaced: true } : {}),
        },
      });
    else if (act === "undeprecate")
      await recordAudit(tx, {
        action: "registry.undeprecated",
        target: { ...target, to: "approved" as const },
      });
    else
      await recordAudit(tx, {
        action: act === "deprecate" ? "registry.deprecated" : "registry.withdrawn",
        target: { ...target, from: v.state },
      });
    return {
      ok: true,
      retired: {
        skillId,
        name: v.name,
        semver: input.semver,
        versionId: v.id,
        act,
        state: to,
        before,
        siblingIds,
        revokedAt,
      },
    };
  });
}

/** A whole skill's deprecation, naming a replacement (another live catalog skill) or not. */
export function deprecateSkill(
  db: KobeDb,
  input: {
    readonly skillId: string;
    readonly actor: Actor;
    readonly replacementId?: string | undefined;
  },
): Promise<RetireResult> {
  const { skillId, actor } = input;
  return db.transaction(async (tx): Promise<RetireResult> => {
    const found = await tx.execute<{ name: string; status: string }>(sql`
      SELECT name, status::text AS status FROM registry_skills WHERE id = ${skillId} FOR UPDATE`);
    const s = found.rows[0];
    if (!s) return { ok: false, code: "not_found" };
    if (!(await mayAct(tx, "deprecate", skillId, actor))) return { ok: false, code: "forbidden" };
    if (s.status !== "active" && s.status !== "unmaintained")
      return { ok: false, code: "wrong_state" };
    if (input.replacementId) {
      const ok = await tx.execute(sql`
        SELECT 1 FROM registry_skills r
         WHERE r.id = ${input.replacementId} AND r.id <> ${skillId}
           AND r.status IN ('active', 'unmaintained')
           AND EXISTS (SELECT 1 FROM registry_versions v WHERE v.skill_id = r.id
                        AND v.state = 'approved' AND v.suspended_at IS NULL)`);
      if (ok.rows.length === 0) return { ok: false, code: "bad_replacement" };
    }
    const before = await versionsBefore(tx, skillId);
    await tx.execute(sql`
      UPDATE registry_skills SET status = 'deprecated', replacement_id = ${input.replacementId ?? null},
        updated_at = now()
       WHERE id = ${skillId}`);
    // `from` (review L1): where an undo returns it to.
    await recordAudit(tx, {
      action: "skill.catalog.deprecated",
      target: {
        skillId,
        name: s.name,
        replacementId: input.replacementId ?? null,
        from: s.status as "active" | "unmaintained",
        byAdmin: siteRoleAllows(actor.siteRole, "site.skills.catalog.manage"),
      },
    });
    return {
      ok: true,
      retired: {
        skillId,
        name: s.name,
        semver: null,
        versionId: null,
        act: "deprecate",
        state: "deprecated",
        before,
        siblingIds: [],
        revokedAt: null,
      },
    };
  });
}

export interface PublishedVersionRow {
  readonly semver: string;
  readonly state: string;
  readonly suspended: boolean;
}

/** A skill's status and published versions, newest first, for those who may act on them. */
export async function publishedForActors(
  db: KobeDb,
  skillId: string,
  who: Actor,
): Promise<
  | {
      readonly status: string;
      readonly mayRetire: boolean;
      readonly versions: PublishedVersionRow[];
    }
  | "not_found"
  | "forbidden"
> {
  return db.transaction(async (tx) => {
    const s = await tx.execute<{ status: string }>(
      sql`SELECT status::text AS status FROM registry_skills WHERE id = ${skillId}`,
    );
    const status = s.rows[0]?.status;
    if (!status) return "not_found" as const;
    const admin = siteRoleAllows(who.siteRole, "site.skills.catalog.manage");
    if (!admin && !(await isActiveMaintainer(tx, skillId, who.userId))) return "forbidden" as const;
    const v = await tx.execute<{ semver: string; state: string; suspended: boolean }>(sql`
      SELECT semver, state::text AS state, suspended_at IS NOT NULL AS suspended
        FROM registry_versions
       WHERE skill_id = ${skillId}
         AND state::text IN ('approved', 'deprecated', 'withdrawn', 'revoked')
       ORDER BY seq DESC`);
    return { status, mayRetire: admin, versions: v.rows };
  });
}

/**
 * Undoes a skill's deprecation (KOBE-340): back to the status it left (the deprecation's audit
 * row, `from`; active when unknown), the replacement cleared. Maintainers and Site admins; no
 * notice (an undo isn't news, and a notice would let a deprecate–undo loop flood installers).
 */
export function undeprecateSkill(
  db: KobeDb,
  input: { readonly skillId: string; readonly actor: Actor },
): Promise<RetireResult> {
  const { skillId, actor } = input;
  return db.transaction(async (tx): Promise<RetireResult> => {
    const found = await tx.execute<{ name: string; status: string }>(sql`
      SELECT name, status::text AS status FROM registry_skills WHERE id = ${skillId} FOR UPDATE`);
    const s = found.rows[0];
    if (!s) return { ok: false, code: "not_found" };
    if (!(await mayAct(tx, "undeprecate", skillId, actor))) return { ok: false, code: "forbidden" };
    if (s.status !== "deprecated") return { ok: false, code: "wrong_state" };
    const last = await tx.execute<{ from: string | null; by_admin: boolean | null }>(sql`
      SELECT target ->> 'from' AS from, (target ->> 'byAdmin')::boolean AS by_admin FROM audit_log
       WHERE action = 'skill.catalog.deprecated' AND target ->> 'skillId' = ${skillId}
       ORDER BY seq DESC LIMIT 1`);
    // A maintainer doesn't undo a Site admin's deprecation (review-341 L4).
    if (
      last.rows[0]?.by_admin === true &&
      !siteRoleAllows(actor.siteRole, "site.skills.catalog.manage")
    )
      return { ok: false, code: "forbidden" };
    const to = last.rows[0]?.from === "unmaintained" ? "unmaintained" : "active";
    const before = await versionsBefore(tx, skillId);
    await tx.execute(sql`
      UPDATE registry_skills SET status = ${to}::registry_skill_status, replacement_id = NULL,
        updated_at = now()
       WHERE id = ${skillId}`);
    await recordAudit(tx, {
      action: "skill.catalog.undeprecated",
      target: { skillId, name: s.name, to },
    });
    return {
      ok: true,
      retired: {
        skillId,
        name: s.name,
        semver: null,
        versionId: null,
        act: "undeprecate",
        state: to,
        before,
        siblingIds: [],
        revokedAt: null,
      },
    };
  });
}
