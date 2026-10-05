import { createHash } from "node:crypto";
import type { AgentDefinition } from "@kobe/agent-file";
import { and, eq, installAgents, sql, SYSTEM_ACTOR, type KobeDb } from "@kobe/db";
import { canonicalJson } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { INSTALL, installWhere } from "../agents/store.js";
import { publishAgent } from "../agents/versions.js";
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
  readonly action: "created" | "updated" | "unchanged" | "skipped_archived";
}

/** Hash of what a definition publishes: changes exactly when the repo's definition changes. */
export const definitionHash = (definition: AgentDefinition): string =>
  createHash("sha256")
    .update(canonicalJson({ frontmatter: definition.frontmatter, prompt: definition.prompt }))
    .digest("hex");

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
  { key, definition }: ParsedGalleryDefinition,
  hash: string,
): Promise<{ agentId: string; action: SeedResult["action"]; publish: boolean }> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ ...INSTALL, galleryHash: installAgents.galleryHash })
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
        .select({ id: installAgents.id, slug: installAgents.slug })
        .from(installAgents)
        .where(and(installWhere(GALLERY), eq(installAgents.slug, key)))
        .for("update");
      const [row] = legacy
        ? await tx
            .update(installAgents)
            .set({ ...values, galleryKey: key, revision: bump() })
            .where(eq(installAgents.id, legacy.id))
            .returning({ id: installAgents.id, revision: installAgents.revision })
        : await tx
            .insert(installAgents)
            .values({ ...values, slug: key, scope: "gallery", galleryKey: key })
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
    if (found.archivedAt !== null) {
      return { agentId: found.id, action: "skipped_archived", publish: false };
    }
    if (found.galleryHash === hash && found.currentVersion !== null) {
      return { agentId: found.id, action: "unchanged", publish: false };
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
  const hash = definitionHash(parsed.definition);
  let draft;
  try {
    draft = await ensureDraft(db, parsed, hash);
  } catch (err) {
    // Another replica inserted the same key between our read and write: it is theirs now.
    if (pgCode(err) !== "23505") throw err;
    draft = await ensureDraft(db, parsed, hash);
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
      .set({ galleryHash: hash })
      .where(and(installWhere(GALLERY), eq(installAgents.id, agentId)));
  }
  return { key: parsed.key, agentId, action };
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
  for (const definition of parsed) results.push(await seedOne(db, definition));
  const changed = results.filter((r) => r.action !== "unchanged");
  if (changed.length > 0) logger.info({ agents: changed }, "gallery agents seeded");
  return results;
}
