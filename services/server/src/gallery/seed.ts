import {
  and,
  eq,
  installAgents,
  isNull,
  isNotNull,
  sql,
  SYSTEM_ACTOR,
  type KobeDb,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { INSTALL, installWhere } from "../agents/store.js";
import { deleteOrArchiveAgent, publishAgent } from "../agents/versions.js";
import { logger } from "../logger.js";
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
  readonly action: "created" | "updated" | "unchanged" | "restored" | "skipped_archived" | "failed";
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
        ...INSTALL,
        galleryGeneration: installAgents.galleryGeneration,
        archivedBy: installAgents.archivedBy,
      })
      .from(installAgents)
      .where(and(installWhere(GALLERY), eq(installAgents.galleryKey, key)))
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
      // An agent curated through the old install console under the same slug is adopted.
      const [legacy] = await tx
        .select({
          id: installAgents.id,
          slug: installAgents.slug,
          archivedAt: installAgents.archivedAt,
        })
        .from(installAgents)
        .where(and(installWhere(GALLERY), eq(installAgents.slug, key)))
        .for("update");
      // Archived by hand: never revived behind anyone's back (nor an error at every start).
      if (legacy?.archivedAt) {
        logger.warn({ key }, "gallery definition matches an archived agent; skipped");
        return { agentId: legacy.id, action: "skipped_archived", publish: false };
      }
      const [row] = legacy
        ? await tx
            .update(installAgents)
            .set({ ...values, galleryKey: key, galleryGeneration: generation, revision: bump() })
            .where(eq(installAgents.id, legacy.id))
            .returning({ id: installAgents.id, revision: installAgents.revision })
        : await tx
            .insert(installAgents)
            .values({
              ...values,
              slug: key,
              scope: "gallery",
              galleryKey: key,
              galleryGeneration: generation,
            })
            .returning({ id: installAgents.id, revision: installAgents.revision });
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
        .update(installAgents)
        .set({ archivedAt: null, archivedBy: null, updatedAt: new Date() })
        .where(eq(installAgents.id, found.id));
      await recordAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: "agent.unarchived",
        teamId: null,
        target: target(found.id, found.slug),
      });
      restored = true;
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
      .update(installAgents)
      .set({ ...values, revision: bump() })
      .where(eq(installAgents.id, found.id))
      .returning({ revision: installAgents.revision });
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

const bump = () => sql`${installAgents.revision} + 1`;

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
      .update(installAgents)
      .set({ galleryGeneration: parsed.generation })
      .where(and(installWhere(GALLERY), eq(installAgents.id, agentId)));
  }
  return { key: parsed.key, agentId, action };
}

/**
 * Archives seeded gallery agents whose definition left the repo: gone from the gallery, no new
 * threads, existing threads and team forks untouched. Idempotent (archived ones are skipped).
 */
async function retireRemoved(db: KobeDb, keys: readonly string[]): Promise<string[]> {
  const gone = await db
    .select({ id: installAgents.id, key: installAgents.galleryKey })
    .from(installAgents)
    .where(
      and(
        installWhere(GALLERY),
        isNotNull(installAgents.galleryKey),
        isNull(installAgents.archivedAt),
      ),
    );
  const removed = gone.filter((g) => g.key !== null && !keys.includes(g.key));
  for (const { id } of removed) await deleteOrArchiveAgent(db, GALLERY, id, SYSTEM_ACTOR, "seed");
  return removed.map((g) => g.key ?? "");
}

/**
 * Seeds the gallery from definitions in the repo (KOBE-87): at server start, so install and every
 * upgrade. Idempotent: an unchanged definition does nothing; a changed one replaces the agent's
 * draft and publishes one new version (threads pinned to older versions keep them). Gallery agents
 * are read-only through the API, so the repo is the only way to change them.
 */
export async function seedGalleryAgents(
  db: KobeDb,
  definitions: readonly GalleryDefinition[] = GALLERY_DEFINITIONS,
): Promise<SeedResult[]> {
  const parsed = parseGalleryDefinitions(definitions);
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
  try {
    const retired = await retireRemoved(
      db,
      parsed.map((p) => p.key),
    );
    if (retired.length > 0) logger.info({ retired }, "gallery agents retired");
  } catch (err) {
    logger.error({ err }, "gallery agents could not be retired");
  }
  const changed = results.filter((r) => r.action !== "unchanged");
  if (changed.length > 0) logger.info({ agents: changed }, "gallery agents seeded");
  return results;
}
