import {
  SYSTEM_ACTOR,
  and,
  asc,
  eq,
  inArray,
  isNull,
  registryMaintainers,
  registrySkills,
  registryVersions,
  siteRoles,
  users,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { siteRoleAllows, type SiteRole } from "../../authz/permissions.js";
import { logger } from "../../logger.js";
import type { Mailer } from "../../mail/mailer.js";
import { oneLine } from "../../mail/messages.js";
import { isReservedName } from "./names.js";

/**
 * Maintainers of catalog skills (KOBE-332, SK24). The first approved submitter becomes the first
 * maintainer (the review ticket calls {@link recordFirstMaintainer} at approval); maintainers add
 * and remove maintainers (never the last one); Site admins may do the same and reassign the whole
 * list. Only maintainers submit new versions ({@link submissionRight}). When the last active
 * maintainer is deactivated the skill shows Unmaintained (it keeps working) and Site admins are
 * emailed; an active maintainer again (added, reassigned or reactivated) makes it active.
 */

type Db = KobeDb | KobeTx;

/** A submission still waiting on its review or its author: it holds a never-approved name. */
const OPEN_STATES = ["submitted", "in_review", "changes_requested"] as const;

export const MAINTAINERS_MAX = 20;

export interface Maintainer {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly deactivated: boolean;
  readonly addedAt: string;
}

export interface Actor {
  readonly userId: string;
  readonly siteRole: SiteRole;
}

export async function listMaintainers(db: Db, skillId: string): Promise<Maintainer[]> {
  const rows = await db
    .select({
      userId: registryMaintainers.userId,
      name: users.name,
      email: users.email,
      deactivatedAt: users.deactivatedAt,
      addedAt: registryMaintainers.addedAt,
    })
    .from(registryMaintainers)
    .innerJoin(users, eq(users.id, registryMaintainers.userId))
    .where(eq(registryMaintainers.skillId, skillId))
    .orderBy(asc(users.name));
  return rows.map(({ deactivatedAt, addedAt, ...r }) => ({
    ...r,
    deactivated: deactivatedAt !== null,
    addedAt: addedAt.toISOString(),
  }));
}

async function skillOf(tx: Db, skillId: string, lock = false) {
  const q = tx
    .select({
      id: registrySkills.id,
      name: registrySkills.name,
      status: registrySkills.status,
      publisher: registrySkills.publisher,
    })
    .from(registrySkills)
    .where(eq(registrySkills.id, skillId));
  const [row] = lock ? await q.for("update") : await q;
  return row;
}

const activeMaintainers = (list: readonly Maintainer[]) => list.filter((m) => !m.deactivated);

/** May `actor` change this skill's maintainers: an active maintainer, or a Site admin. */
function mayManage(list: readonly Maintainer[], actor: Actor): boolean {
  return (
    siteRoleAllows(actor.siteRole, "site.skills.catalog.manage") ||
    activeMaintainers(list).some((m) => m.userId === actor.userId)
  );
}

/** Unmaintained → active once an active maintainer exists again (audited). */
async function maintainedAgain(tx: KobeTx, skill: { id: string; name: string; status: string }) {
  if (skill.status !== "unmaintained") return;
  await tx
    .update(registrySkills)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(registrySkills.id, skill.id));
  await recordAudit(tx, {
    action: "skill.catalog.maintained",
    target: { skillId: skill.id, name: skill.name },
  });
}

async function activeUser(tx: Db, userId: string): Promise<boolean> {
  const [u] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deactivatedAt)));
  return u !== undefined;
}

export type MaintainerResult =
  | { readonly ok: true; readonly maintainers: Maintainer[] }
  | {
      readonly ok: false;
      readonly code:
        | "not_found"
        | "forbidden"
        | "user_not_found"
        | "last_maintainer"
        | "too_many"
        | "kobe_skill";
      readonly message: string;
    };

const fail = (code: Extract<MaintainerResult, { ok: false }>["code"], message: string) =>
  ({ ok: false, code, message }) as const;

/** Checks every change shares: the skill exists, isn't Kobe's, and the actor may manage it. */
async function guard(tx: KobeTx, skillId: string, actor: Actor) {
  const skill = await skillOf(tx, skillId, true);
  if (!skill) return fail("not_found", "No catalog skill with that id.");
  if (skill.publisher === "kobe") return fail("kobe_skill", "Kobe maintains its own skills.");
  const list = await listMaintainers(tx, skillId);
  if (!mayManage(list, actor))
    return fail("forbidden", "Only its maintainers or a Site admin can change its maintainers.");
  return { skill, list };
}

export async function addMaintainer(
  db: KobeDb,
  skillId: string,
  userId: string,
  actor: Actor,
): Promise<MaintainerResult> {
  return db.transaction(async (tx) => {
    const g = await guard(tx, skillId, actor);
    if ("ok" in g) return g;
    if (!(await activeUser(tx, userId)))
      return fail("user_not_found", "No active user with that id.");
    if (g.list.some((m) => m.userId === userId)) return { ok: true, maintainers: g.list };
    if (g.list.length >= MAINTAINERS_MAX)
      return fail("too_many", `A skill has at most ${MAINTAINERS_MAX} maintainers.`);
    await tx.insert(registryMaintainers).values({ skillId, userId, addedBy: actor.userId });
    await recordAudit(tx, { action: "skill.maintainer.added", target: { skillId, userId } });
    await maintainedAgain(tx, g.skill);
    return { ok: true, maintainers: await listMaintainers(tx, skillId) };
  });
}

export async function removeMaintainer(
  db: KobeDb,
  skillId: string,
  userId: string,
  actor: Actor,
): Promise<MaintainerResult> {
  return db.transaction(async (tx) => {
    const g = await guard(tx, skillId, actor);
    if ("ok" in g) return g;
    if (!g.list.some((m) => m.userId === userId))
      return fail("user_not_found", "That user doesn't maintain this skill.");
    const left = activeMaintainers(g.list).filter((m) => m.userId !== userId);
    if (left.length === 0)
      return fail(
        "last_maintainer",
        "A skill keeps at least one active maintainer: add another first, or a Site admin reassigns it.",
      );
    await tx
      .delete(registryMaintainers)
      .where(and(eq(registryMaintainers.skillId, skillId), eq(registryMaintainers.userId, userId)));
    await recordAudit(tx, { action: "skill.maintainer.removed", target: { skillId, userId } });
    return { ok: true, maintainers: await listMaintainers(tx, skillId) };
  });
}

/** A Site admin replaces the whole list (SK24 "Site admins can reassign"). */
export async function reassignMaintainers(
  db: KobeDb,
  skillId: string,
  userIds: readonly string[],
  actor: Actor,
): Promise<MaintainerResult> {
  if (!siteRoleAllows(actor.siteRole, "site.skills.catalog.manage"))
    return fail("forbidden", "Only a Site admin reassigns maintainers.");
  const unique = [...new Set(userIds)];
  if (unique.length === 0 || unique.length > MAINTAINERS_MAX)
    return fail("too_many", `Name 1 to ${MAINTAINERS_MAX} maintainers.`);
  return db.transaction(async (tx) => {
    const g = await guard(tx, skillId, actor);
    if ("ok" in g) return g;
    const active = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, unique), isNull(users.deactivatedAt)));
    if (active.length !== unique.length)
      return fail("user_not_found", "Every maintainer must be an active user.");
    await tx.delete(registryMaintainers).where(eq(registryMaintainers.skillId, skillId));
    await tx
      .insert(registryMaintainers)
      .values(unique.map((userId) => ({ skillId, userId, addedBy: actor.userId })));
    await recordAudit(tx, {
      action: "skill.maintainers.reassigned",
      target: { skillId, userIds: unique },
    });
    await maintainedAgain(tx, g.skill);
    return { ok: true, maintainers: await listMaintainers(tx, skillId) };
  });
}

/**
 * At a skill's first approval its submitter becomes the first maintainer (SK24). For the review
 * ticket's approve transaction; does nothing once the skill has maintainers.
 */
export async function recordFirstMaintainer(
  tx: KobeTx,
  skillId: string,
  userId: string,
): Promise<void> {
  const [any] = await tx
    .select({ userId: registryMaintainers.userId })
    .from(registryMaintainers)
    .where(eq(registryMaintainers.skillId, skillId))
    .limit(1);
  if (any) return;
  await tx.insert(registryMaintainers).values({ skillId, userId, addedBy: null });
  await recordAudit(tx, {
    action: "skill.maintainer.added",
    actor: SYSTEM_ACTOR,
    target: { skillId, userId },
  });
}

export type SubmissionRight =
  | { readonly ok: true; readonly skill: { readonly id: string; readonly name: string } | null }
  | {
      readonly ok: false;
      readonly code: "reserved" | "taken" | "not_maintainer" | "unmaintained" | "archived";
      readonly message: string;
    };

/**
 * May `userId` submit a version named `name` (KOBE-332, SK24; the promotion ticket calls it)?
 * A new name: yes (`skill: null`), unless it is Kobe's. An existing catalog skill: only its active
 * maintainers; before its first approval (no maintainers yet) only whoever has a submission open
 * under it, and anyone once every submission was rejected (KOBE-334). Anyone else is told who
 * maintains it.
 */
export async function submissionRight(
  tx: Db,
  name: string,
  userId: string,
): Promise<SubmissionRight> {
  if (isReservedName(name))
    return { ok: false, code: "reserved", message: `${name} is reserved for Kobe's own skill.` };
  const [skill] = await tx
    .select({ id: registrySkills.id, name: registrySkills.name, status: registrySkills.status })
    .from(registrySkills)
    .where(eq(registrySkills.name, name));
  if (!skill) return { ok: true, skill: null };
  if (skill.status === "archived")
    return { ok: false, code: "archived", message: `${name} is archived; choose another name.` };
  const all = await listMaintainers(tx, skill.id);
  const list = activeMaintainers(all);
  if (list.some((m) => m.userId === userId)) return { ok: true, skill };
  // Before its first approval it has no maintainer rows at all: whoever has a submission open
  // under the name goes on; once none is open (every one rejected), the name is free again for
  // anyone (review C3-M2: a rejected first submission never squats a name). An Unmaintained skill
  // (rows, none active) reopens only when a Site admin reassigns it (review C3-M1): a maintainer
  // removed earlier never wins the right back.
  if (all.length === 0) {
    const open = await tx
      .select({ submittedBy: registryVersions.submittedBy })
      .from(registryVersions)
      .where(
        and(
          eq(registryVersions.skillId, skill.id),
          inArray(registryVersions.state, [...OPEN_STATES]),
        ),
      );
    if (open.length === 0 || open.some((o) => o.submittedBy === userId)) return { ok: true, skill };
    return {
      ok: false,
      code: "taken",
      message: `${name} is taken in the Catalog; fork it under a new name.`,
    };
  }
  if (list.length === 0)
    return {
      ok: false,
      code: "unmaintained",
      message: `${name} is Unmaintained: ask a Site admin to reassign its maintainers.`,
    };
  const names = list.map((m) => m.name).join(", ");
  return {
    ok: false,
    code: "not_maintainer",
    message: `${name} is maintained by ${names}; fork it under a new name or ask to be added.`,
  };
}

export interface UnmaintainedSkill {
  readonly id: string;
  readonly name: string;
}

/**
 * The user was deactivated: every active catalog skill they maintain with no other active
 * maintainer becomes Unmaintained (audited, system). Returns those skills.
 */
export async function markUnmaintained(db: KobeDb, userId: string): Promise<UnmaintainedSkill[]> {
  return db.transaction(async (tx) => {
    const mine = await tx
      .select({ id: registrySkills.id, name: registrySkills.name })
      .from(registryMaintainers)
      .innerJoin(registrySkills, eq(registrySkills.id, registryMaintainers.skillId))
      .where(and(eq(registryMaintainers.userId, userId), eq(registrySkills.status, "active")))
      .for("update", { of: registrySkills });
    const out: UnmaintainedSkill[] = [];
    for (const skill of mine) {
      if (activeMaintainers(await listMaintainers(tx, skill.id)).length > 0) continue;
      await tx
        .update(registrySkills)
        .set({ status: "unmaintained", updatedAt: new Date() })
        .where(eq(registrySkills.id, skill.id));
      await recordAudit(tx, {
        action: "skill.catalog.unmaintained",
        actor: SYSTEM_ACTOR,
        target: { skillId: skill.id, name: skill.name },
      });
      out.push(skill);
    }
    return out;
  });
}

/** The user was reactivated: their Unmaintained skills are maintained again. */
export async function markMaintainedAgain(db: KobeDb, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const mine = await tx
      .select({ id: registrySkills.id, name: registrySkills.name, status: registrySkills.status })
      .from(registryMaintainers)
      .innerJoin(registrySkills, eq(registrySkills.id, registryMaintainers.skillId))
      .where(and(eq(registryMaintainers.userId, userId), eq(registrySkills.status, "unmaintained")))
      .for("update", { of: registrySkills });
    for (const skill of mine) await maintainedAgain(tx, skill);
  });
}

/** Emails the Owner and every active Site admin about skills that became Unmaintained. */
export async function notifyUnmaintained(
  deps: { readonly db: KobeDb; readonly mailer: Mailer; readonly publicUrl: string },
  skills: readonly UnmaintainedSkill[],
): Promise<number> {
  if (skills.length === 0) return 0;
  const admins = await deps.db
    .select({ id: users.id, email: users.email })
    .from(siteRoles)
    .innerJoin(users, eq(users.id, siteRoles.userId))
    .where(isNull(users.deactivatedAt));
  const text = [
    "These catalog skills lost their last active maintainer and now show Unmaintained.",
    "They keep working. Reassign their maintainers in the Site console.",
    ...skills.map((s) => `  - ${oneLine(s.name)}`),
    "",
    `${deps.publicUrl}/admin/site/skill-tags`,
  ].join("\n");
  let sent = 0;
  for (const admin of admins) {
    try {
      await deps.mailer.send({
        to: admin.email,
        subject: "Kobe: catalog skills unmaintained",
        text,
      });
      sent += 1;
    } catch (err) {
      logger.warn({ err, userId: admin.id }, "skills: unmaintained email failed");
    }
  }
  return sent;
}
