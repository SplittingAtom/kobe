import type { AgentDefinition, AgentFrontmatter } from "@kobe/agent-file";
import { AGENT_SLUG_MAX } from "@kobe/agent-file";
import {
  and,
  eq,
  installAgents,
  sql,
  teamAgents,
  withTeam,
  type AgentStatus,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { z } from "zod";
import type { AgentScope } from "./access.js";

/**
 * Agent definitions in Postgres (spec D19). Team agents live in the team table `team_agents` and
 * are always read and written inside `withTeam`; personal and gallery agents live in the
 * install-wide `install_agents`, where every query is pinned to its scope (and, for personal
 * agents, to the owner). A row is the agent's editable draft; published versions are KOBE-46.
 */

export interface AgentRecord {
  readonly id: string;
  readonly scope: AgentScope;
  readonly ownerUserId: string | null;
  readonly slug: string;
  readonly status: AgentStatus;
  readonly frontmatter: AgentFrontmatter;
  readonly prompt: string;
  readonly revision: number;
  readonly currentVersion: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Where an agent lives; every store call is confined to one location. */
export type AgentLocation =
  | { readonly scope: "team"; readonly teamId: string }
  | { readonly scope: "personal"; readonly ownerUserId: string }
  | { readonly scope: "gallery" };

/** Per-location caps: keeps lists bounded without pagination. */
export const AGENT_CAPS: Readonly<Record<AgentScope, number>> = {
  team: 500,
  personal: 100,
  gallery: 100,
};

export type CreateError = "slug_taken" | "limit_reached";
export type UpdateError = "not_found" | "revision_mismatch";
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

const columnsOf = (t: typeof teamAgents | typeof installAgents) => ({
  id: t.id,
  ownerUserId: t.ownerUserId,
  slug: t.slug,
  status: t.status,
  frontmatter: t.frontmatter,
  prompt: t.prompt,
  revision: t.revision,
  currentVersion: t.currentVersion,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});
const TEAM = columnsOf(teamAgents);
const INSTALL = columnsOf(installAgents);

type Row = Omit<AgentRecord, "scope" | "frontmatter"> & { frontmatter: Record<string, unknown> };

const toRecord = (scope: AgentScope, row: Row): AgentRecord => ({
  ...row,
  scope,
  // Written only after validation by @kobe/agent-file.
  frontmatter: row.frontmatter as AgentFrontmatter,
});

const OWNER_ID = z.uuid();

/**
 * The only wall between users' personal agents: install_agents has no RLS (install-wide, D6), so
 * every install_agents query goes through here and a personal location must name a valid owner.
 */
function installWhere(location: Exclude<AgentLocation, { scope: "team" }>) {
  if (location.scope === "gallery") return eq(installAgents.scope, "gallery");
  if (!OWNER_ID.safeParse(location.ownerUserId).success) {
    throw new Error("store: personal agents need an owner (a user id)");
  }
  return and(
    eq(installAgents.scope, "personal"),
    eq(installAgents.ownerUserId, location.ownerUserId),
  );
}

/** Runs `fn` in the right transaction: team-scoped (RLS) for team agents, plain otherwise. */
function inLocation<T>(db: KobeDb, location: AgentLocation, fn: (tx: KobeTx) => Promise<T>) {
  return location.scope === "team"
    ? withTeam(db, location.teamId, fn)
    : db.transaction((tx) => fn(tx));
}

export async function listAgents(db: KobeDb, location: AgentLocation): Promise<AgentRecord[]> {
  const rows: Row[] =
    location.scope === "team"
      ? await withTeam(db, location.teamId, (tx) => tx.select(TEAM).from(teamAgents))
      : await db.select(INSTALL).from(installAgents).where(installWhere(location));
  return rows
    .map((r) => toRecord(location.scope, r))
    .sort(
      (a, b) =>
        a.frontmatter.name.localeCompare(b.frontmatter.name) || a.slug.localeCompare(b.slug),
    );
}

/**
 * Finds an agent visible from the caller's active team: a team agent of that team, one of the
 * caller's own personal agents, or a gallery agent. Anything else is "not found" (no oracle).
 */
export async function findVisibleAgent(
  db: KobeDb,
  caller: { teamId: string; userId: string },
  id: string,
): Promise<AgentRecord | null> {
  const team = await findAgent(db, { scope: "team", teamId: caller.teamId }, id);
  if (team) return team;
  return (
    (await findAgent(db, { scope: "personal", ownerUserId: caller.userId }, id)) ??
    (await findAgent(db, { scope: "gallery" }, id))
  );
}

export async function findAgent(
  db: KobeDb,
  location: AgentLocation,
  id: string,
): Promise<AgentRecord | null> {
  const [row]: Row[] =
    location.scope === "team"
      ? await withTeam(db, location.teamId, (tx) =>
          tx.select(TEAM).from(teamAgents).where(eq(teamAgents.id, id)),
        )
      : await db
          .select(INSTALL)
          .from(installAgents)
          .where(and(installWhere(location), eq(installAgents.id, id)));
  return row ? toRecord(location.scope, row) : null;
}

/** Picks `base`, or `base-2`, `base-3`, … when taken; null when nothing fits. */
export function pickSlug(taken: ReadonlySet<string>, base: string): string | null {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 999; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, AGENT_SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

export interface NewAgent {
  readonly definition: AgentDefinition;
  /** Explicit slug: taken → `slug_taken`. Otherwise `baseSlug` gets a numeric suffix if taken. */
  readonly slug?: string | undefined;
  readonly baseSlug: string;
  /** Creator (team agents) or owner (personal); ignored for gallery agents. */
  readonly ownerUserId: string | null;
}

export async function createAgent(
  db: KobeDb,
  location: AgentLocation,
  input: NewAgent,
): Promise<Result<AgentRecord, CreateError>> {
  try {
    return await inLocation(db, location, async (tx) => {
      // Serializes creates per location, so the cap and the picked slug can't race.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(location)}, 0))`,
      );
      const taken = new Set(await takenSlugs(tx, location));
      if (taken.size >= AGENT_CAPS[location.scope]) return { ok: false, error: "limit_reached" };
      const slug = input.slug ?? pickSlug(taken, input.baseSlug);
      if (slug === null || taken.has(slug)) return { ok: false, error: "slug_taken" };
      const values = {
        slug,
        frontmatter: input.definition.frontmatter,
        prompt: input.definition.prompt,
      };
      const [row] =
        location.scope === "team"
          ? await tx
              .insert(teamAgents)
              .values({ ...values, teamId: location.teamId, ownerUserId: requireOwner(input) })
              .returning(TEAM)
          : await tx
              .insert(installAgents)
              .values({
                ...values,
                scope: location.scope,
                ownerUserId: location.scope === "personal" ? location.ownerUserId : null,
              })
              .returning(INSTALL);
      if (!row) throw new Error("agent insert returned no row");
      return { ok: true, value: toRecord(location.scope, row) };
    });
  } catch (err) {
    // Defensive: creates are serialized per location, so this needs a racing non-create write.
    if (pgCode(err) === "23505") return { ok: false, error: "slug_taken" };
    throw err;
  }
}

function lockKey(location: AgentLocation): string {
  if (location.scope === "team") return `kobe.agents.team:${location.teamId}`;
  if (location.scope === "personal") return `kobe.agents.personal:${location.ownerUserId}`;
  return "kobe.agents.gallery";
}

function requireOwner(input: NewAgent): string {
  if (!input.ownerUserId) throw new Error("team agents need a creator");
  return input.ownerUserId;
}

async function takenSlugs(tx: KobeTx, location: AgentLocation): Promise<string[]> {
  const rows =
    location.scope === "team"
      ? await tx.select({ slug: teamAgents.slug }).from(teamAgents)
      : await tx
          .select({ slug: installAgents.slug })
          .from(installAgents)
          .where(installWhere(location));
  return rows.map((r) => r.slug);
}

/**
 * Replaces an agent's draft. With `expectedRevision`, only if nobody changed it since (the
 * client's If-Match); the revision then moves on by one.
 */
export async function updateAgent(
  db: KobeDb,
  location: AgentLocation,
  id: string,
  definition: AgentDefinition,
  expectedRevision?: number,
): Promise<Result<AgentRecord, UpdateError>> {
  const set = {
    frontmatter: definition.frontmatter,
    prompt: definition.prompt,
    updatedAt: new Date(),
  };
  return inLocation(db, location, async (tx) => {
    const [row] =
      location.scope === "team"
        ? await tx
            .update(teamAgents)
            .set({ ...set, revision: sql`${teamAgents.revision} + 1` })
            .where(
              and(
                eq(teamAgents.id, id),
                expectedRevision === undefined
                  ? undefined
                  : eq(teamAgents.revision, expectedRevision),
              ),
            )
            .returning(TEAM)
        : await tx
            .update(installAgents)
            .set({ ...set, revision: sql`${installAgents.revision} + 1` })
            .where(
              and(
                installWhere(location),
                eq(installAgents.id, id),
                expectedRevision === undefined
                  ? undefined
                  : eq(installAgents.revision, expectedRevision),
              ),
            )
            .returning(INSTALL);
    if (row) return { ok: true, value: toRecord(location.scope, row) };
    const exists = await existsIn(tx, location, id);
    return { ok: false, error: exists ? "revision_mismatch" : "not_found" };
  });
}

async function existsIn(tx: KobeTx, location: AgentLocation, id: string): Promise<boolean> {
  const rows =
    location.scope === "team"
      ? await tx.select({ id: teamAgents.id }).from(teamAgents).where(eq(teamAgents.id, id))
      : await tx
          .select({ id: installAgents.id })
          .from(installAgents)
          .where(and(installWhere(location), eq(installAgents.id, id)));
  return rows.length > 0;
}

/** Deletes a draft-only agent; false when it doesn't exist in `location`. */
export async function deleteAgent(
  db: KobeDb,
  location: AgentLocation,
  id: string,
): Promise<boolean> {
  return inLocation(db, location, async (tx) => {
    const rows =
      location.scope === "team"
        ? await tx.delete(teamAgents).where(eq(teamAgents.id, id)).returning({ id: teamAgents.id })
        : await tx
            .delete(installAgents)
            .where(and(installWhere(location), eq(installAgents.id, id)))
            .returning({ id: installAgents.id });
    return rows.length > 0;
  });
}

/** Suspends or reactivates an agent (inventory, D19); null when it doesn't exist. */
export async function setAgentStatus(
  db: KobeDb,
  location: AgentLocation,
  id: string,
  status: AgentStatus,
): Promise<AgentRecord | null> {
  return inLocation(db, location, async (tx) => {
    const [row] =
      location.scope === "team"
        ? await tx
            .update(teamAgents)
            .set({ status, updatedAt: new Date() })
            .where(eq(teamAgents.id, id))
            .returning(TEAM)
        : await tx
            .update(installAgents)
            .set({ status, updatedAt: new Date() })
            .where(and(installWhere(location), eq(installAgents.id, id)))
            .returning(INSTALL);
    return row ? toRecord(location.scope, row) : null;
  });
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
}
