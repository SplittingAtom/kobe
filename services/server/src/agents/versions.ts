import { suspendedInTeam } from "./inventory.js";
import { validateAgentDefinition, type AgentDefinition } from "@kobe/agent-file";
import {
  and,
  desc,
  eq,
  installAgents,
  installAgentVersions,
  lt,
  sql,
  teamAgents,
  teamAgentVersions,
  type AgentScope,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { canonicalJson } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { readPublishFloor } from "./floor.js";
import { computeToolManifest, toolManifestSchema, type ToolManifest } from "./manifest.js";
import {
  auditTeam,
  inLocation,
  installWhere,
  INSTALL,
  lockAgent,
  TEAM,
  toRecord,
  type AgentLocation,
  type AgentRecord,
  type Result,
  type Row,
} from "./store.js";

/**
 * Published agent versions (spec D19, KOBE-46). Publish copies an agent's draft into an immutable
 * numbered version with a frozen tool manifest (`manifest.ts`) and moves `current_version` to it;
 * rollback republishes an older version's content as a new number (manifest recomputed against
 * today's floor). Versions only grow: `current_version` is always the newest. Every change locks
 * the agent row first, so concurrent publishes get consecutive numbers. The database refuses to
 * change or delete a version and threads pin versions with NO ACTION foreign keys; an agent with
 * versions is archived, never deleted.
 */

export interface AgentVersionSummary {
  readonly version: number;
  readonly publishedBy: string;
  readonly publishedAt: Date;
  /** The draft revision published; null for a rollback. */
  readonly draftRevision: number | null;
  /** For a rollback: the version it republished. */
  readonly republishedFrom: number | null;
}

export interface AgentVersionRecord extends AgentVersionSummary {
  readonly agentId: string;
  readonly definition: AgentDefinition;
  readonly toolManifest: ToolManifest;
}

export type PublishError =
  | "not_found"
  | "revision_mismatch"
  | "archived"
  | "version_not_found"
  | "already_current"
  | "invalid_draft"
  | "unchanged"
  | "version_limit";

/** Limits on versions (review M3): versions are immutable and never deleted by the app. */
export interface VersionLimits {
  /** Versions per agent (they only grow; `current_version` is the count). */
  readonly maxVersions: number;
}

/** Sane default: years of daily publishing per agent, small next to the per-team agent cap. */
export const DEFAULT_VERSION_LIMITS: VersionLimits = { maxVersions: 1000 };

export interface Published {
  readonly agent: AgentRecord;
  readonly version: AgentVersionRecord;
}

const SUMMARY_COLUMNS = (t: typeof teamAgentVersions | typeof installAgentVersions) => ({
  version: t.version,
  publishedBy: t.publishedBy,
  publishedAt: t.publishedAt,
  draftRevision: t.draftRevision,
  republishedFrom: t.republishedFrom,
});
const FULL_COLUMNS = (t: typeof teamAgentVersions | typeof installAgentVersions) => ({
  ...SUMMARY_COLUMNS(t),
  agentId: t.agentId,
  frontmatter: t.frontmatter,
  prompt: t.prompt,
  toolManifest: t.toolManifest,
});

type FullRow = AgentVersionSummary & {
  agentId: string;
  frontmatter: Record<string, unknown>;
  prompt: string;
  toolManifest: Record<string, unknown>;
};

/** A stored version whose tool manifest doesn't parse (manual SQL, a future format). */
export class UnreadableVersionError extends Error {
  readonly code = "version_unreadable";
  constructor(
    readonly agentId: string,
    readonly version: number,
  ) {
    super(`agent ${agentId} version ${version} has an unreadable tool manifest`);
    this.name = "UnreadableVersionError";
  }
}

/**
 * A stored version as a record. The manifest is re-validated on every read: one that doesn't
 * parse throws `UnreadableVersionError` rather than run with an unknown tool set (fail closed).
 */
function toVersion(row: FullRow): AgentVersionRecord {
  const { frontmatter, prompt, toolManifest, ...rest } = row;
  const manifest = toolManifestSchema.safeParse(toolManifest);
  if (!manifest.success) throw new UnreadableVersionError(row.agentId, row.version);
  return {
    ...rest,
    // Copied from a validated draft at publish time.
    definition: { frontmatter, prompt } as AgentDefinition,
    toolManifest: manifest.data,
  };
}

/** Versions of an agent in `location`, newest first; null when the agent isn't there. */
export async function listVersions(
  db: KobeDb,
  location: AgentLocation,
  agentId: string,
  page: { before?: number | undefined; limit: number },
): Promise<AgentVersionSummary[] | null> {
  return inLocation(db, location, async (tx) => {
    if (!(await agentExists(tx, location, agentId))) return null;
    const t = location.scope === "team" ? teamAgentVersions : installAgentVersions;
    return tx
      .select(SUMMARY_COLUMNS(t))
      .from(t)
      .where(and(eq(t.agentId, agentId), page.before ? lt(t.version, page.before) : undefined))
      .orderBy(desc(t.version))
      .limit(page.limit);
  });
}

/** One version of an agent in `location`; null when either doesn't exist there. */
export async function getVersion(
  db: KobeDb,
  location: AgentLocation,
  agentId: string,
  version: number,
): Promise<AgentVersionRecord | null> {
  return inLocation(db, location, async (tx) => {
    if (!(await agentExists(tx, location, agentId))) return null;
    return readVersion(tx, location.scope, agentId, version);
  });
}

async function agentExists(tx: KobeTx, location: AgentLocation, id: string): Promise<boolean> {
  const rows =
    location.scope === "team"
      ? await tx.select({ id: teamAgents.id }).from(teamAgents).where(eq(teamAgents.id, id))
      : await tx
          .select({ id: installAgents.id })
          .from(installAgents)
          .where(and(installWhere(location), eq(installAgents.id, id)));
  return rows.length > 0;
}

/** A version row by number (callers have already confined the agent to its location). */
async function readVersion(
  tx: KobeTx,
  scope: AgentScope,
  agentId: string,
  version: number,
): Promise<AgentVersionRecord | null> {
  const t = scope === "team" ? teamAgentVersions : installAgentVersions;
  const [row] = await tx
    .select(FULL_COLUMNS(t))
    .from(t)
    .where(and(eq(t.agentId, agentId), eq(t.version, version)));
  return row ? toVersion(row) : null;
}

interface NewVersion {
  readonly limits: VersionLimits;
  readonly definition: AgentDefinition;
  readonly publishedBy: string;
  readonly draftRevision: number | null;
  readonly republishedFrom: number | null;
}

/** Content that makes two versions the same: definition and frozen manifest. */
const contentKey = (definition: AgentDefinition, manifest: ToolManifest): string =>
  canonicalJson({ frontmatter: definition.frontmatter, prompt: definition.prompt, manifest });

/** Whether `definition` + `manifest` equal the agent's current version (an unreadable one never does). */
async function sameAsCurrent(
  tx: KobeTx,
  location: AgentLocation,
  agent: AgentRecord,
  definition: AgentDefinition,
  manifest: ToolManifest,
): Promise<boolean> {
  if (agent.currentVersion === null) return false;
  try {
    const current = await readVersion(tx, location.scope, agent.id, agent.currentVersion);
    return (
      current !== null &&
      contentKey(current.definition, current.toolManifest) === contentKey(definition, manifest)
    );
  } catch (err) {
    if (err instanceof UnreadableVersionError) return false;
    throw err;
  }
}

/**
 * Inserts the next version of the locked `agent` and points `current_version` at it. Refuses a
 * version identical to the current one (same definition and manifest: a republish that only picks
 * up a changed floor is not identical) and agents at the version cap.
 */
async function insertVersion(
  tx: KobeTx,
  location: AgentLocation,
  agent: AgentRecord,
  input: NewVersion,
): Promise<Result<Published, "unchanged" | "version_limit">> {
  const now = new Date();
  const floor = await readPublishFloor(tx, location.scope === "team" ? "team" : "install");
  const manifest = computeToolManifest(input.definition.frontmatter, floor, now);
  if (await sameAsCurrent(tx, location, agent, input.definition, manifest)) {
    return { ok: false, error: "unchanged" };
  }
  if ((agent.currentVersion ?? 0) >= input.limits.maxVersions) {
    return { ok: false, error: "version_limit" };
  }
  const values = {
    agentId: agent.id,
    version: (agent.currentVersion ?? 0) + 1,
    frontmatter: input.definition.frontmatter,
    prompt: input.definition.prompt,
    toolManifest: manifest,
    publishedBy: input.publishedBy,
    publishedAt: now,
    draftRevision: input.draftRevision,
    republishedFrom: input.republishedFrom,
  };
  let row: FullRow | undefined;
  let updated: Row | undefined;
  if (location.scope === "team") {
    [row] = await tx
      .insert(teamAgentVersions)
      .values({ ...values, teamId: location.teamId })
      .returning(FULL_COLUMNS(teamAgentVersions));
    [updated] = await tx
      .update(teamAgents)
      .set({ currentVersion: values.version, updatedAt: now })
      .where(eq(teamAgents.id, agent.id))
      .returning(TEAM);
  } else {
    [row] = await tx
      .insert(installAgentVersions)
      .values(values)
      .returning(FULL_COLUMNS(installAgentVersions));
    [updated] = await tx
      .update(installAgents)
      .set({ currentVersion: values.version, updatedAt: now })
      .where(and(installWhere(location), eq(installAgents.id, agent.id)))
      .returning(INSTALL);
  }
  if (!row || !updated) throw new Error("agent version insert returned no row");
  return { ok: true, value: { agent: toRecord(location.scope, updated), version: toVersion(row) } };
}

const ref = (location: AgentLocation, agent: AgentRecord) => ({
  agentId: agent.id,
  scope: location.scope,
  slug: agent.slug,
});

/**
 * Publishes the agent's draft as its next version (D19). With `expectedRevision`, only if the
 * draft is still that revision (the publisher's If-Match): nobody publishes changes they haven't
 * seen. The draft is validated again, so a draft stored under an older schema can't be frozen.
 */
export async function publishAgent(
  db: KobeDb,
  location: AgentLocation,
  id: string,
  input: {
    readonly publishedBy: string;
    readonly expectedRevision: number | undefined;
    readonly limits?: VersionLimits;
  },
): Promise<Result<Published, PublishError>> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    if (!agent) return { ok: false, error: "not_found" };
    if (agent.archivedAt) return { ok: false, error: "archived" };
    if (input.expectedRevision !== undefined && agent.revision !== input.expectedRevision) {
      return { ok: false, error: "revision_mismatch" };
    }
    const draft = validateAgentDefinition({
      frontmatter: agent.frontmatter,
      prompt: agent.prompt,
    });
    if (!draft.ok) return { ok: false, error: "invalid_draft" };
    const inserted = await insertVersion(tx, location, agent, {
      limits: input.limits ?? DEFAULT_VERSION_LIMITS,
      definition: draft.definition,
      publishedBy: input.publishedBy,
      draftRevision: agent.revision,
      republishedFrom: null,
    });
    if (!inserted.ok) return inserted;
    const published = inserted.value;
    await recordAudit(tx, {
      action: "agent.published",
      teamId: auditTeam(location),
      target: {
        ...ref(location, agent),
        version: published.version.version,
        draftRevision: agent.revision,
      },
    });
    return { ok: true, value: published };
  });
}

/**
 * Rolls back (D19 "rollback republishes an older version"): `fromVersion`'s content becomes a new
 * version, with its manifest recomputed against today's floor. The draft is left alone (it may
 * hold the fix in progress). Threads keep their pins; new threads get the new version.
 */
export async function rollbackAgent(
  db: KobeDb,
  location: AgentLocation,
  id: string,
  input: {
    readonly publishedBy: string;
    readonly fromVersion: number;
    readonly limits?: VersionLimits;
  },
): Promise<Result<Published, PublishError>> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    if (!agent) return { ok: false, error: "not_found" };
    if (agent.archivedAt) return { ok: false, error: "archived" };
    if (agent.currentVersion === input.fromVersion) return { ok: false, error: "already_current" };
    const source = await readVersion(tx, location.scope, id, input.fromVersion);
    if (!source) return { ok: false, error: "version_not_found" };
    const inserted = await insertVersion(tx, location, agent, {
      limits: input.limits ?? DEFAULT_VERSION_LIMITS,
      definition: source.definition,
      publishedBy: input.publishedBy,
      draftRevision: null,
      republishedFrom: source.version,
    });
    if (!inserted.ok) return inserted;
    const published = inserted.value;
    await recordAudit(tx, {
      action: "agent.rolled_back",
      teamId: auditTeam(location),
      target: {
        ...ref(location, agent),
        version: published.version.version,
        fromVersion: source.version,
      },
    });
    return { ok: true, value: published };
  });
}

export type Removed =
  { readonly kind: "deleted" } | { readonly kind: "archived"; readonly agent: AgentRecord };

/**
 * Deletes an agent that was never published (nothing can reference it) or archives one that was
 * (KOBE-45 decision 6): its versions stay, threads pinned to them keep working, it can't be
 * edited, published or pinned by new threads. Archiving twice changes nothing. Null when the agent
 * doesn't exist in `location`.
 */
export async function deleteOrArchiveAgent(
  db: KobeDb,
  location: AgentLocation,
  id: string,
): Promise<Removed | null> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    if (!agent) return null;
    if (agent.currentVersion === null) {
      if (location.scope === "team") {
        await tx.delete(teamAgents).where(eq(teamAgents.id, id));
      } else {
        await tx.delete(installAgents).where(and(installWhere(location), eq(installAgents.id, id)));
      }
      await recordAudit(tx, {
        action: "agent.deleted",
        teamId: auditTeam(location),
        target: ref(location, agent),
      });
      return { kind: "deleted" };
    }
    if (agent.archivedAt) return { kind: "archived", agent };
    const archived = await setArchived(tx, location, id, new Date());
    await recordAudit(tx, {
      action: "agent.archived",
      teamId: auditTeam(location),
      target: ref(location, agent),
    });
    return { kind: "archived", agent: archived };
  });
}

/** Brings an archived agent back (editable, publishable, pinnable). Null when it isn't there. */
export async function unarchiveAgent(
  db: KobeDb,
  location: AgentLocation,
  id: string,
): Promise<AgentRecord | null> {
  return inLocation(db, location, async (tx) => {
    const agent = await lockAgent(tx, location, id);
    if (!agent) return null;
    if (!agent.archivedAt) return agent;
    const restored = await setArchived(tx, location, id, null);
    await recordAudit(tx, {
      action: "agent.unarchived",
      teamId: auditTeam(location),
      target: ref(location, agent),
    });
    return restored;
  });
}

async function setArchived(
  tx: KobeTx,
  location: AgentLocation,
  id: string,
  archivedAt: Date | null,
): Promise<AgentRecord> {
  const set = { archivedAt, updatedAt: new Date() };
  const [row]: Row[] =
    location.scope === "team"
      ? await tx.update(teamAgents).set(set).where(eq(teamAgents.id, id)).returning(TEAM)
      : await tx
          .update(installAgents)
          .set(set)
          .where(and(installWhere(location), eq(installAgents.id, id)))
          .returning(INSTALL);
  if (!row) throw new Error("agent archive update returned no row");
  return toRecord(location.scope, row);
}

// --- Thread pins (D19: threads pin the version they started on) ------------------------------

/** What a thread stores to pin an agent version. */
export interface AgentPin {
  readonly agentScope: AgentScope;
  readonly agentId: string;
  readonly agentVersion: number;
}

/** Who is asking, inside the thread's `withTeam` transaction. */
export interface PinViewer {
  readonly teamId: string;
  readonly userId: string;
}

export type PinError = "agent_not_found" | "agent_unavailable" | "version_not_found";

/**
 * The agent `agentId` as the user sees it from the active team: a team agent of that team (RLS),
 * one of the user's own personal agents, or a gallery agent. Anything else is "not found".
 * `lock` takes `FOR SHARE` on the agent row for the rest of `tx`, so a concurrent archive, suspend
 * or publish can't commit between this check and the pin being written. Lock order: thread row
 * (if any) before agent row; agent changes (`lockAgent`) never lock threads.
 */
export async function findPinnableAgent(
  tx: KobeTx,
  viewer: PinViewer,
  agentId: string,
  options: { lock?: boolean } = {},
): Promise<AgentRecord | null> {
  const teamQuery = tx
    .select(TEAM)
    .from(teamAgents)
    .where(and(eq(teamAgents.teamId, viewer.teamId), eq(teamAgents.id, agentId)));
  const [team]: Row[] = await (options.lock ? teamQuery.for("share") : teamQuery);
  if (team) return toRecord("team", team);
  const installQuery = tx
    .select({ ...INSTALL, scope: installAgents.scope })
    .from(installAgents)
    .where(
      and(
        eq(installAgents.id, agentId),
        sql`(${installAgents.scope} = 'gallery' OR (${installAgents.scope} = 'personal' AND ${installAgents.ownerUserId} = ${viewer.userId}::uuid))`,
      ),
    );
  const [own]: (Row & { scope: "personal" | "gallery" })[] = await (options.lock
    ? installQuery.for("share")
    : installQuery);
  if (!own) return null;
  const { scope, ...row } = own;
  const record = toRecord(scope, row);
  // A team can suspend an install-wide agent for itself (KOBE-86): effective status here.
  return record.status === "active" && (await suspendedInTeam(tx, viewer.teamId, agentId))
    ? { ...record, status: "suspended" }
    : record;
}

/** Why an agent can't be pinned by a new thread or a switch, if it can't. */
function unavailable(agent: AgentRecord): boolean {
  return agent.status !== "active" || agent.archivedAt !== null || agent.currentVersion === null;
}

/**
 * The pin a new thread takes for `agentId` (`POST /v1/threads`): the agent's current published
 * version. Null agent → null pin (the install default agent). Suspended, archived and never
 * published agents can't start threads.
 */
export async function resolveAgentPin(
  tx: KobeTx,
  viewer: PinViewer,
  agentId: string | null,
): Promise<Result<AgentPin | null, PinError>> {
  if (agentId === null) return { ok: true, value: null };
  const agent = await findPinnableAgent(tx, viewer, agentId, { lock: true });
  if (!agent) return { ok: false, error: "agent_not_found" };
  if (unavailable(agent) || agent.currentVersion === null) {
    return { ok: false, error: "agent_unavailable" };
  }
  return {
    ok: true,
    value: { agentScope: agent.scope, agentId: agent.id, agentVersion: agent.currentVersion },
  };
}

/**
 * The pin for switching an existing thread (one-click switch, D19): `version` (default: the
 * agent's current version) of the agent the thread is already pinned to, in the same scope.
 */
export async function resolveSwitchPin(
  tx: KobeTx,
  viewer: PinViewer,
  current: Pick<AgentPin, "agentScope" | "agentId">,
  version: number | undefined,
): Promise<Result<AgentPin, PinError>> {
  const agent = await findPinnableAgent(tx, viewer, current.agentId, { lock: true });
  if (!agent || agent.scope !== current.agentScope) return { ok: false, error: "agent_not_found" };
  if (unavailable(agent) || agent.currentVersion === null) {
    return { ok: false, error: "agent_unavailable" };
  }
  const target = version ?? agent.currentVersion;
  if (target !== agent.currentVersion && !(await readVersion(tx, agent.scope, agent.id, target))) {
    return { ok: false, error: "version_not_found" };
  }
  return { ok: true, value: { agentScope: agent.scope, agentId: agent.id, agentVersion: target } };
}

/**
 * The newest version of a thread's pinned agent ("v3 available", D19), looked up as the thread's
 * owner sees it. Null when the thread has no agent or the agent is gone from the owner's view.
 */
export async function latestPinnedVersion(
  tx: KobeTx,
  thread: { teamId: string; ownerUserId: string; agentId: string | null },
): Promise<number | null> {
  if (thread.agentId === null) return null;
  const agent = await findPinnableAgent(
    tx,
    { teamId: thread.teamId, userId: thread.ownerUserId },
    thread.agentId,
  );
  return agent?.currentVersion ?? null;
}

export type PinnedAgent =
  | {
      readonly ok: true;
      readonly agent: AgentRecord;
      readonly version: AgentVersionRecord;
    }
  | {
      readonly ok: false;
      readonly error:
        "agent_not_found" | "version_not_found" | "version_unreadable" | "agent_suspended";
    };

/**
 * **Seam for run-time resolution (KOBE-47).** The exact agent version a thread is pinned to, for
 * the thread's owner, inside the run's `withTeam` transaction. Never falls back: a pinned agent or
 * version that is missing or unreadable is an error for the run, never the default agent or
 * another version. Suspended agents are refused (`agent_suspended`); archived agents still serve
 * the threads already pinned to them; a version whose manifest doesn't parse is
 * `version_unreadable`. The caller then intersects the version with the team
 * (`versionAllowsCall`, `effectiveApprovalMode`, the team's models and connectors).
 */
export async function resolvePinnedAgent(
  tx: KobeTx,
  owner: PinViewer,
  pin: AgentPin,
): Promise<PinnedAgent> {
  const agent = await findPinnableAgent(tx, owner, pin.agentId);
  if (!agent || agent.scope !== pin.agentScope) return { ok: false, error: "agent_not_found" };
  if (agent.status === "suspended") return { ok: false, error: "agent_suspended" };
  try {
    const version = await readVersion(tx, agent.scope, agent.id, pin.agentVersion);
    if (!version) return { ok: false, error: "version_not_found" };
    return { ok: true, agent, version };
  } catch (err) {
    if (err instanceof UnreadableVersionError) return { ok: false, error: "version_unreadable" };
    throw err;
  }
}
