import {
  and,
  asc,
  eq,
  inArray,
  registrySkillTags,
  registrySkills,
  registryTags,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { pgCodeOf } from "@kobe/db";
import type { SystemTag } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import {
  defaultTargets,
  lockDefaultSet,
  newestApproved,
  type TargetVersion,
} from "./default-target.js";
import { queueDefaultSync } from "./default-sync.js";

/**
 * Catalog tags (KOBE-314, SK5): the topic vocabulary Site admins manage (added, renamed, retired
 * or restored, never deleted) and the tags on catalog skills. System tags are code-defined
 * (`default` only); applying or removing one is audited and starts a Default sync (SK8).
 */
export type Tag = typeof registryTags.$inferSelect;

const isUniqueViolation = (err: unknown) => pgCodeOf(err) === "23505";

export const listTags = (db: KobeDb): Promise<Tag[]> =>
  db.select().from(registryTags).orderBy(asc(registryTags.kind), asc(registryTags.name));

export type TagResult = { ok: true; tag: Tag } | { ok: false; code: "exists" | "not_found" };

export async function createTopicTag(db: KobeDb, name: string): Promise<TagResult> {
  try {
    return await db.transaction(async (tx) => {
      const [tag] = await tx.insert(registryTags).values({ name, kind: "topic" }).returning();
      if (!tag) throw new Error("skills: tag insert returned no row");
      await recordAudit(tx, { action: "skill.tag.created", target: { tagId: tag.id, name } });
      return { ok: true as const, tag };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: "exists" };
    throw err;
  }
}

/** Renames, retires or restores a topic tag. System tags are not changed here (or anywhere). */
export async function updateTopicTag(
  db: KobeDb,
  id: string,
  change: {
    readonly name?: string | undefined;
    readonly status?: "active" | "retired" | undefined;
  },
): Promise<TagResult> {
  try {
    return await db.transaction(async (tx) => {
      const [old] = await tx
        .select()
        .from(registryTags)
        .where(and(eq(registryTags.id, id), eq(registryTags.kind, "topic")))
        .for("update");
      if (!old) return { ok: false as const, code: "not_found" as const };
      const [tag] = await tx
        .update(registryTags)
        .set({ name: change.name ?? old.name, status: change.status ?? old.status })
        .where(eq(registryTags.id, id))
        .returning();
      if (!tag) throw new Error("skills: tag update returned no row");
      await recordAudit(tx, {
        action: "skill.tag.updated",
        target: {
          tagId: id,
          name: tag.name,
          status: tag.status,
          ...(tag.name !== old.name ? { previousName: old.name } : {}),
        },
      });
      return { ok: true as const, tag };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: "exists" };
    throw err;
  }
}

export type SetTagsResult =
  | {
      readonly ok: true;
      readonly system: readonly string[];
      readonly topic: readonly string[];
      /** The Default sync job this change queued, if it changed the Default tag. */
      readonly syncId: string | null;
    }
  | {
      readonly ok: false;
      readonly code: "not_found" | "unknown_tags" | "no_version";
      readonly tags?: readonly string[];
    };

const diff = (from: readonly string[], to: readonly string[]) => ({
  added: to.filter((t) => !from.includes(t)),
  removed: from.filter((t) => !to.includes(t)),
});

async function currentTags(tx: KobeTx, skillId: string) {
  return tx
    .select({ id: registryTags.id, name: registryTags.name, kind: registryTags.kind })
    .from(registrySkillTags)
    .innerJoin(registryTags, eq(registryTags.id, registrySkillTags.tagId))
    .where(eq(registrySkillTags.skillId, skillId));
}

/**
 * Sets a catalog skill's tags to exactly `system` + `topic` (SK5). A topic tag being added must be
 * active (a retired one already on the skill may stay). Adding Default needs an approved version
 * and queues an `add` sync at that version's major; removing it queues a `remove` sync. The
 * change, its audit and the job commit together under the exclusive Default-set lock.
 */
export async function setSkillTags(
  db: KobeDb,
  skillId: string,
  want: { readonly system: readonly SystemTag[]; readonly topic: readonly string[] },
  actorId: string,
): Promise<SetTagsResult> {
  return db.transaction(async (tx): Promise<SetTagsResult> => {
    await lockDefaultSet(tx, "exclusive");
    const [skill] = await tx
      .select({ id: registrySkills.id, name: registrySkills.name })
      .from(registrySkills)
      .where(eq(registrySkills.id, skillId))
      .for("update");
    if (!skill) return { ok: false, code: "not_found" };
    const now = await currentTags(tx, skillId);
    const system = diff(
      now.filter((t) => t.kind === "system").map((t) => t.name),
      [...new Set(want.system)],
    );
    const topic = diff(
      now.filter((t) => t.kind === "topic").map((t) => t.name),
      [...new Set(want.topic)],
    );
    const addNames = [...system.added, ...topic.added];
    const adding =
      addNames.length === 0
        ? []
        : await tx.select().from(registryTags).where(inArray(registryTags.name, addNames));
    const usable = new Map(
      adding
        .filter(
          (t) => t.status === "active" && (t.kind === "system") === system.added.includes(t.name),
        )
        .map((t) => [t.name, t.id]),
    );
    const unknown = addNames.filter((n) => !usable.has(n));
    if (unknown.length > 0) return { ok: false, code: "unknown_tags", tags: unknown };

    let target: TargetVersion | null = null;
    if (system.added.includes("default")) {
      target = await newestApproved(tx, skillId);
      if (!target) return { ok: false, code: "no_version" };
    }
    const removeIds = now
      .filter((t) => system.removed.includes(t.name) || topic.removed.includes(t.name))
      .map((t) => t.id);
    if (removeIds.length > 0)
      await tx
        .delete(registrySkillTags)
        .where(
          and(eq(registrySkillTags.skillId, skillId), inArray(registrySkillTags.tagId, removeIds)),
        );
    if (usable.size > 0)
      await tx
        .insert(registrySkillTags)
        .values([...usable.values()].map((tagId) => ({ skillId, tagId, addedBy: actorId })));

    let syncId: string | null = null;
    if (target)
      syncId = await queueDefaultSync(tx, { skillId, kind: "add", target, requestedBy: actorId });
    else if (system.removed.includes("default"))
      syncId = await queueDefaultSync(tx, { skillId, kind: "remove", requestedBy: actorId });

    if (addNames.length + removeIds.length > 0)
      await recordAudit(tx, {
        action: "skill.catalog.tags_changed",
        target: {
          skillId,
          name: skill.name,
          systemAdded: system.added,
          systemRemoved: system.removed,
          topicAdded: topic.added,
          topicRemoved: topic.removed,
        },
      });
    const after = await currentTags(tx, skillId);
    return {
      ok: true,
      system: after
        .filter((t) => t.kind === "system")
        .map((t) => t.name)
        .sort(),
      topic: after
        .filter((t) => t.kind === "topic")
        .map((t) => t.name)
        .sort(),
      syncId,
    };
  });
}

export type MoveMajorResult =
  | { readonly ok: true; readonly syncId: string; readonly semver: string }
  | {
      readonly ok: false;
      readonly code: "not_found" | "not_default" | "not_newer" | "no_version";
      readonly major?: number;
    };

/**
 * Moves a Default skill's Default installs to a new major (SK6): audited, and only installs the
 * tag still owns on Track within major move (the sync's `move_major` step). New teams get the new
 * major from then on.
 */
export async function moveDefaultMajor(
  db: KobeDb,
  skillId: string,
  to: number,
  actorId: string,
): Promise<MoveMajorResult> {
  return db.transaction(async (tx): Promise<MoveMajorResult> => {
    await lockDefaultSet(tx, "exclusive");
    const [skill] = await tx
      .select({ name: registrySkills.name })
      .from(registrySkills)
      .where(eq(registrySkills.id, skillId));
    if (!skill) return { ok: false, code: "not_found" };
    const [current] = await defaultTargets(tx, skillId);
    if (!current) return { ok: false, code: "not_default" };
    if (to <= current.major) return { ok: false, code: "not_newer", major: current.major };
    const target = await newestApproved(tx, skillId, to);
    if (!target) return { ok: false, code: "no_version" };
    const syncId = await queueDefaultSync(tx, {
      skillId,
      kind: "move_major",
      target,
      requestedBy: actorId,
    });
    await recordAudit(tx, {
      action: "skill.default.major_moved",
      target: {
        skillId,
        name: skill.name,
        fromMajor: current.major,
        toMajor: to,
        semver: target.semver,
      },
    });
    return { ok: true, syncId, semver: target.semver };
  });
}
