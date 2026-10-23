import { and, eq, siteAgents, isNull, isNotNull, sql, SYSTEM_ACTOR, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { SITE, siteWhere } from "../agents/store.js";
import { archiveAgent, publishAgent } from "../agents/versions.js";
import { logger } from "../logger.js";
import { rememberSeeded } from "./customization.js";
import {
  GALLERY_DEFINITIONS,
  parseGalleryDefinitions,
  type GalleryDefinition,
  type ParsedGalleryDefinition,
} from "./definitions.js";

const GALLERY = { scope: "gallery" } as const;

export interface SeedResult {
  readonly key: string;
  readonly agentId: string;
  readonly action:
    | "created"
    | "updated"
    | "unchanged"
    | "restored"
    | "skipped_archived"
    | "skipped_customized"
    /** Its definition left the repo, but a site admin customized it: not archived (KOBE-494). */
    | "kept_customized"
    | "failed";
}

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
};

/**
 * Makes the gallery agent for `key` match the repo's definition (draft only; the version comes
 * next). Locks the row so replicas starting together serialize. Returns the agent id and whether
 * anything has to be published; an archived agent is left alone (never revived behind its back).
 */
async function ensureDraft(
  db: KobeDb,
  { key, generation, definition }: ParsedGalleryDefinition,
): Promise<{ agentId: string; action: SeedResult["action"]; publish: boolean }> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({
        ...SITE,
        galleryGeneration: siteAgents.galleryGeneration,
        archivedBy: siteAgents.archivedBy,
        customizedAt: siteAgents.customizedAt,
      })
      .from(siteAgents)
      .where(and(siteWhere(GALLERY), eq(siteAgents.galleryKey, key)))
      .for("update");
    const values = {
      frontmatter: definition.frontmatter,
      prompt: definition.prompt,
      updatedAt: new Date(),
    };
    const target = (agentId: string, slug: string) => ({
      agentId,
      scope: "gallery" as const,
      slug,
    });
    if (!found) {
      // An agent curated through the old site console under the same slug is adopted.
      const [legacy] = await tx
        .select({
          id: siteAgents.id,
          slug: siteAgents.slug,
          archivedAt: siteAgents.archivedAt,
        })
        .from(siteAgents)
        .where(and(siteWhere(GALLERY), eq(siteAgents.slug, key)))
        .for("update");
      // Archived by hand: never revived behind anyone's back (nor an error at every start).
      if (legacy?.archivedAt) {
        logger.warn({ key }, "gallery definition matches an archived agent; skipped");
        return { agentId: legacy.id, action: "skipped_archived", publish: false };
      }
      const [row] = legacy
        ? await tx
            .update(siteAgents)
            .set({ ...values, galleryKey: key, galleryGeneration: generation, revision: bump() })
            .where(eq(siteAgents.id, legacy.id))
            .returning({ id: siteAgents.id, revision: siteAgents.revision })
        : await tx
            .insert(siteAgents)
            .values({
              ...values,
              slug: key,
              scope: "gallery",
              galleryKey: key,
              galleryGeneration: generation,
            })
            .returning({ id: siteAgents.id, revision: siteAgents.revision });
      if (!row) throw new Error("gallery seed: insert returned no row");
      const ref = target(row.id, key);
      await recordAudit(
        tx,
        legacy
          ? {
              actor: SYSTEM_ACTOR,
              action: "agent.updated",
              teamId: null,
              target: { ...ref, revision: row.revision, source: "seed" },
            }
          : {
              actor: SYSTEM_ACTOR,
              action: "agent.created",
              teamId: null,
              target: { ...ref, source: "seed" },
            },
      );
      return { agentId: row.id, action: "created", publish: true };
    }
    let restored = false;
    if (found.archivedAt !== null) {
      // Archived by a person: never revived. Archived because its definition left the repo (an
      // older release, a rollback): back again, so it comes back.
      if (found.archivedBy !== "seed") {
        return { agentId: found.id, action: "skipped_archived", publish: false };
      }
      await tx
        .update(siteAgents)
        .set({ archivedAt: null, archivedBy: null, updatedAt: new Date() })
        .where(eq(siteAgents.id, found.id));
      await recordAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: "agent.unarchived",
        teamId: null,
        target: target(found.id, found.slug),
      });
      restored = true;
    }
    // Customized by a site admin (KOBE-494): never overwritten. The repo's newer generation is
    // still recorded (never lowered), so the console can say an update is available.
    if (found.customizedAt !== null) {
      if (found.galleryGeneration === null || found.galleryGeneration < generation) {
        await tx
          .update(siteAgents)
          .set({ galleryGeneration: generation })
          .where(eq(siteAgents.id, found.id));
      }
      return { agentId: found.id, action: "skipped_customized", publish: false };
    }
    // Same or newer generation already seeded: an older replica (rollout, rollback) changes nothing.
    if (
      found.currentVersion !== null &&
      found.galleryGeneration !== null &&
      found.galleryGeneration >= generation
    ) {
      return { agentId: found.id, action: restored ? "restored" : "unchanged", publish: false };
    }
    const [row] = await tx
      .update(siteAgents)
      .set({ ...values, revision: bump() })
      .where(eq(siteAgents.id, found.id))
      .returning({ revision: siteAgents.revision });
    if (!row) throw new Error("gallery seed: update returned no row");
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: "agent.updated",
      teamId: null,
      target: { ...target(found.id, found.slug), revision: row.revision, source: "seed" },
    });
    return { agentId: found.id, action: "updated", publish: true };
  });
}

const bump = () => sql`${siteAgents.revision} + 1`;

async function seedOne(db: KobeDb, parsed: ParsedGalleryDefinition): Promise<SeedResult> {
  let draft;
  try {
    draft = await ensureDraft(db, parsed);
  } catch (err) {
    // Another replica inserted the same key between our read and write: it is theirs now.
    if (pgCode(err) !== "23505") throw err;
    draft = await ensureDraft(db, parsed);
  }
  const { agentId, action } = draft;
  if (draft.publish) {
    const published = await publishAgent(db, GALLERY, agentId, {
      publishedBy: null,
      actor: SYSTEM_ACTOR,
      expectedRevision: undefined,
    });
    // "unchanged": another replica (or an earlier, interrupted run) published this very content.
    if (!published.ok && published.error !== "unchanged") {
      throw new Error(`gallery seed: ${parsed.key} could not be published (${published.error})`);
    }
    await db
      .update(siteAgents)
      .set({ galleryGeneration: parsed.generation })
      .where(and(siteWhere(GALLERY), eq(siteAgents.id, agentId)));
  }
  return { key: parsed.key, agentId, action };
}

/**
 * Archives seeded gallery agents whose definition left the repo (KOBE-254): gone from the gallery,
 * no new threads, existing threads and team forks untouched. Never deletes, not even one that was
 * never published. Idempotent (archived ones are skipped). A customized agent (KOBE-494) is
 * detached from the repo, so it is kept: reported `kept_customized`, never archived.
 */
async function retireRemoved(
  db: KobeDb,
  keys: readonly string[],
): Promise<{ retired: string[]; kept: SeedResult[] }> {
  const gone = await db
    .select({
      id: siteAgents.id,
      key: siteAgents.galleryKey,
      customizedAt: siteAgents.customizedAt,
    })
    .from(siteAgents)
    .where(
      and(siteWhere(GALLERY), isNotNull(siteAgents.galleryKey), isNull(siteAgents.archivedAt)),
    );
  const removed = gone.filter((g) => g.key !== null && !keys.includes(g.key));
  const retire = removed.filter((g) => g.customizedAt === null);
  for (const { id } of retire) await archiveAgent(db, GALLERY, id, SYSTEM_ACTOR, "seed");
  return {
    retired: retire.map((g) => g.key ?? ""),
    kept: removed
      .filter((g) => g.customizedAt !== null)
      .map((g) => ({ key: g.key ?? "", agentId: g.id, action: "kept_customized" as const })),
  };
}

async function retireAll(
  db: KobeDb,
  parsed: readonly ParsedGalleryDefinition[],
): Promise<SeedResult[]> {
  try {
    const { retired, kept } = await retireRemoved(
      db,
      parsed.map((p) => p.key),
    );
    if (retired.length > 0) logger.info({ retired }, "gallery agents retired");
    if (kept.length > 0) {
      logger.info(
        { kept: kept.map((k) => k.key) },
        "gallery agents kept: customized, though their definition left the repository",
      );
    }
    return kept;
  } catch (err) {
    logger.error({ err }, "gallery agents could not be retired");
    return [];
  }
}

/**
 * Seeds one definition now (KOBE-494: Reset to repository brings the repo's definition at once
 * instead of at the next start). Nothing is retired.
 */
export async function seedGalleryAgent(
  db: KobeDb,
  definition: ParsedGalleryDefinition,
): Promise<SeedResult> {
  return seedOne(db, definition);
}

/**
 * Seeds the gallery from definitions in the repo (KOBE-87): at server start, so install and every
 * upgrade. Idempotent: an unchanged definition does nothing; a changed one replaces the agent's
 * draft and publishes one new version (threads pinned to older versions keep them). A gallery
 * agent a site admin customized (KOBE-494) is skipped until they reset it to the repository.
 */
export async function seedGalleryAgents(
  db: KobeDb,
  definitions: readonly GalleryDefinition[] = GALLERY_DEFINITIONS,
): Promise<SeedResult[]> {
  const parsed = parseGalleryDefinitions(definitions);
  // Compare and Reset to repository (KOBE-494) read the definitions this server seeded.
  rememberSeeded(parsed);
  const results: SeedResult[] = [];
  // One definition failing (say, a row in an unexpected state) must not stop the server starting.
  for (const definition of parsed) {
    try {
      results.push(await seedOne(db, definition));
    } catch (err) {
      logger.error({ err, key: definition.key }, "gallery agent could not be seeded");
      results.push({ key: definition.key, agentId: "", action: "failed" });
    }
  }
  // Retire only once every definition is seeded and published (KOBE-254): a failed seed must not
  // leave the gallery without its replacement. The next start tries again.
  const failed = results.filter((r) => r.action === "failed").map((r) => r.key);
  if (failed.length > 0) {
    logger.warn({ failed }, "gallery retirement postponed: a definition failed to seed");
  } else {
    results.push(...(await retireAll(db, parsed)));
  }
  const changed = results.filter((r) => r.action !== "unchanged");
  if (changed.length > 0) logger.info({ agents: changed }, "gallery agents seeded");
  return results;
}
