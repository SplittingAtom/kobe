import { serializeAgentFile, type AgentDefinition } from "@kobe/agent-file";
import { and, eq, isNotNull, isNull, siteAgents, sql, type KobeDb } from "@kobe/db";
import { siteWhere } from "../agents/store.js";
import { getVersion } from "../agents/versions.js";
import { recordAudit } from "../audit/record.js";
import {
  GALLERY_DEFINITIONS,
  parseGalleryDefinitions,
  type GalleryDefinition,
  type ParsedGalleryDefinition,
} from "./definitions.js";

/**
 * Customized gallery agents (KOBE-494; D19/D21 as amended by Chris 2026-10-23): a site admin's
 * first draft save or publish of a seeded gallery agent marks it Customized, which detaches it
 * from the repo's definition (the seed skips it). The seed keeps recording the repo's generation,
 * so a newer one than the agent was customized from means "a newer repository version is
 * available"; Reset to repository clears the marker and the seed brings the repo's definition.
 */

const GALLERY = { scope: "gallery" } as const;

/** Where a gallery agent stands against the repo (the Site Console's Customized badge, notice). */
export interface GalleryState {
  /** The repo key; null for a gallery agent not seeded from the repo (never customized). */
  readonly key: string | null;
  /** The newest repo generation the seed has seen for it. */
  readonly generation: number | null;
  readonly customized: boolean;
  readonly customizedAt: string | null;
  readonly customizedBy: string | null;
  readonly customizedFromGeneration: number | null;
  /** Customized and the repo moved on since: Compare and Reset to repository are offered. */
  readonly updateAvailable: boolean;
}

const STATE_COLUMNS = {
  id: siteAgents.id,
  key: siteAgents.galleryKey,
  generation: siteAgents.galleryGeneration,
  customizedAt: siteAgents.customizedAt,
  customizedBy: siteAgents.customizedBy,
  customizedFromGeneration: siteAgents.customizedFromGeneration,
};

type StateRow = {
  readonly key: string | null;
  readonly generation: number | null;
  readonly customizedAt: Date | null;
  readonly customizedBy: string | null;
  readonly customizedFromGeneration: number | null;
};

function toState(row: StateRow): GalleryState {
  const from = row.customizedFromGeneration;
  return {
    key: row.key,
    generation: row.generation,
    customized: row.customizedAt !== null,
    customizedAt: row.customizedAt?.toISOString() ?? null,
    customizedBy: row.customizedBy,
    customizedFromGeneration: from,
    updateAvailable:
      row.customizedAt !== null &&
      from !== null &&
      row.generation !== null &&
      row.generation > from,
  };
}

/** Every gallery agent's state, by agent id. */
export async function galleryStates(db: KobeDb): Promise<ReadonlyMap<string, GalleryState>> {
  const rows = await db.select(STATE_COLUMNS).from(siteAgents).where(siteWhere(GALLERY));
  return new Map(rows.map((r) => [r.id, toState(r)]));
}

export async function galleryState(db: KobeDb, id: string): Promise<GalleryState | null> {
  const [row] = await db
    .select(STATE_COLUMNS)
    .from(siteAgents)
    .where(and(siteWhere(GALLERY), eq(siteAgents.id, id)));
  return row ? toState(row) : null;
}

/**
 * Marks a seeded gallery agent Customized by `userId` (idempotent: only the first edit marks and
 * audits it). Called after a successful draft save or publish. Agents not seeded from the repo
 * have nothing to detach from and stay unmarked.
 */
export async function markCustomized(db: KobeDb, id: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(siteAgents)
      .set({
        customizedAt: new Date(),
        customizedBy: userId,
        customizedFromGeneration: sql`coalesce(${siteAgents.galleryGeneration}, 1)`,
      })
      .where(
        and(
          siteWhere(GALLERY),
          eq(siteAgents.id, id),
          isNotNull(siteAgents.galleryKey),
          isNull(siteAgents.customizedAt),
        ),
      )
      .returning({ slug: siteAgents.slug, from: siteAgents.customizedFromGeneration });
    if (!row) return;
    await recordAudit(tx, {
      action: "agent.customized",
      teamId: null,
      target: { agentId: id, scope: "gallery", slug: row.slug, fromGeneration: row.from ?? 1 },
    });
  });
}

/**
 * Clears the marker and forgets the recorded generation, so the next seed of this key replaces
 * the draft with the repo's definition and publishes it (a new version; D19). False when the agent
 * is not customized (or not a gallery agent, or archived: archived agents stay as they are).
 */
export async function clearCustomized(db: KobeDb, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ from: siteAgents.customizedFromGeneration })
      .from(siteAgents)
      .where(and(siteWhere(GALLERY), eq(siteAgents.id, id)))
      .for("update");
    const [row] = await tx
      .update(siteAgents)
      .set({
        customizedAt: null,
        customizedBy: null,
        customizedFromGeneration: null,
        galleryGeneration: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          siteWhere(GALLERY),
          eq(siteAgents.id, id),
          isNotNull(siteAgents.customizedAt),
          isNull(siteAgents.archivedAt),
        ),
      )
      .returning({ slug: siteAgents.slug });
    if (!row) return false;
    await recordAudit(tx, {
      action: "agent.reset_to_repository",
      teamId: null,
      target: { agentId: id, scope: "gallery", slug: row.slug, fromGeneration: before?.from ?? 1 },
    });
    return true;
  });
}

/**
 * The newest definition per key this server has seeded (tests seed their own fixtures; a seed by
 * an older replica's code never replaces a newer one); before any seed, the ones shipped with this
 * release.
 */
let seeded: ReadonlyMap<string, ParsedGalleryDefinition> | null = null;

export function rememberSeeded(definitions: readonly ParsedGalleryDefinition[]): void {
  const known = new Map(seeded ?? []);
  for (const d of definitions) {
    const before = known.get(d.key);
    if (!before || before.generation <= d.generation) known.set(d.key, d);
  }
  seeded = known;
}

export function repositoryDefinition(
  key: string,
  shipped: readonly GalleryDefinition[] = GALLERY_DEFINITIONS,
): ParsedGalleryDefinition | null {
  if (seeded) return seeded.get(key) ?? null;
  return parseGalleryDefinitions(shipped).find((d) => d.key === key) ?? null;
}

const side = (definition: AgentDefinition) => ({
  frontmatter: definition.frontmatter,
  prompt: definition.prompt,
  file: serializeAgentFile(definition),
});

/** Compare (KOBE-494): the repo's definition and the agent's current version, side by side. */
export async function compareWithRepository(db: KobeDb, id: string, currentVersion: number | null) {
  const state = await galleryState(db, id);
  if (!state) return null;
  const repo = state.key === null ? null : repositoryDefinition(state.key);
  const current =
    currentVersion === null ? null : await getVersion(db, GALLERY, id, currentVersion);
  return {
    gallery: state,
    repository: repo ? { generation: repo.generation, ...side(repo.definition) } : null,
    current: current ? { version: current.version, ...side(current.definition) } : null,
  };
}
