import { Hono, type Context } from "hono";
import {
  agentWarnings,
  isDangerousMode,
  slugFromName,
  type AgentDefinition,
} from "@kobe/agent-file";
import { AGENT_FORK_SCOPE_IGNORED } from "@kobe/protocol";
import {
  agentAccess,
  canCreateAgent,
  canForkAgent,
  forkBinding,
  type AgentActor,
  type AgentScope,
} from "../agents/access.js";
import {
  agentBodyLimit,
  agentDetail,
  agentResponse,
  agentSummary,
  archivedConflict,
  createError,
  etag,
  exportResponse,
  forbidden,
  invalidRequest,
  notFound,
  preconditionFailed,
  readAgentInput,
  ifMatchRevision,
} from "../agents/http.js";
import {
  agentIdSchema,
  agentStatusSchema,
  createMetaSchema,
  forkSchema,
  listQuerySchema,
  updateMetaSchema,
} from "../agents/schemas.js";
import {
  createAgent,
  findAgent,
  findVisibleAgent,
  listAgents,
  setAgentStatus,
  updateAgent,
  type AgentLocation,
  type AgentRecord,
} from "../agents/store.js";
import { mountEvalRoutes } from "../agents/eval/routes.js";
import { currentGalleryScores, galleryScoreView } from "../agents/eval/gallery-scores.js";
import type { EvalRunner } from "../agents/eval/service.js";
import { mountFeedbackTotals } from "../agents/feedback-routes.js";
import { mountAgentEvalCases } from "../eval-cases/routes.js";
import { mountOrbitExport } from "../agents/orbit/routes.js";
import { inventoryQuerySchema, listInventory, setInventoryStatus } from "../agents/inventory.js";
import { listRunnableAgents, runnableQuerySchema } from "../agents/runnable.js";
import { mountVersionRoutes } from "../agents/version-routes.js";
import { AgentRosteredError, refuseIfRostered } from "../agents/roster.js";
import { pendingTransfer } from "../agents/roster-transfer.js";
import { findForkSource, forkDefinition } from "../agents/fork.js";
import { ROSTER_READ_ACCESS, rosterDefinitionRead } from "../agents/roster-read.js";
import { mountAgentRosterRoutes, rosterError } from "./agent-roster.js";
import { mountAgentTransferRoutes } from "./agent-transfer.js";
import { deleteOrArchiveAgent } from "../agents/versions.js";
import { recordAuditAfter } from "../audit/record.js";
import { DANGEROUS_FORBIDDEN, mayUseDangerousMode } from "../policy/dangerous-mode.js";
import { teamRoleAllows } from "../authz/permissions.js";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { parseBody } from "../teams/http.js";

type Ctx = Context<{ Variables: TeamVariables }>;

/** What the recipient of a transfer may do with the offered agent before accepting: look. */
const NO_ACCESS = {
  see: true,
  readDefinition: false,
  edit: false,
  publish: false,
  setStatus: false,
};

const actorOf = (c: Ctx): AgentActor => ({ userId: c.get("user").id, role: c.get("team").role });

/** AC1: site admins (and the Owner) and the active team's admins may use Dangerous mode. */
const mayDangerous = (c: Ctx): boolean =>
  mayUseDangerousMode(c.get("team").role, c.get("siteRole"));

/** A definition in Dangerous mode from someone who may not set it (403), else null. */
const refuseDangerous = (c: Ctx, definition: AgentDefinition): Response | null =>
  isDangerousMode(definition.frontmatter) && !mayDangerous(c)
    ? c.json(DANGEROUS_FORBIDDEN, 403)
    : null;

/** A fork by someone who may not use Dangerous mode drops it: the copy uses the team default. */
function forkable(c: Ctx, definition: AgentDefinition): AgentDefinition {
  if (!isDangerousMode(definition.frontmatter) || mayDangerous(c)) return definition;
  const { approval_mode: _dropped, ...frontmatter } = definition.frontmatter;
  return { ...definition, frontmatter };
}

/** Where a new or existing agent of `scope` lives for this caller. */
function locationFor(c: Ctx, scope: AgentScope): AgentLocation {
  if (scope === "team") return { scope, teamId: c.get("team").id };
  if (scope === "personal") return { scope, ownerUserId: c.get("user").id };
  return { scope };
}

/**
 * Agent definitions from the active team's point of view (spec D19, §6.1 `CRUD /v1/agents`):
 * the team's agents, the caller's personal agents, and the read-only gallery. POST and PUT take
 * JSON or an agent markdown file (import); `GET /:id/export` downloads the file. Versions,
 * publish, rollback and unarchive (KOBE-46) are `agents/version-routes.ts`. Gallery curation is
 * `/v1/site/gallery/agents`.
 */
export function agentRoutes(
  deps: ServerDeps,
  evalOptions: { readonly runner?: EvalRunner } = {},
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  /** The agent if the caller may see it; null → 404 (no existence oracle). */
  async function visible(c: Ctx): Promise<AgentRecord | null> {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return null;
    const agent = await findVisibleAgent(
      db,
      { teamId: c.get("team").id, userId: c.get("user").id },
      id.data,
    );
    return agent && agentAccess(actorOf(c), agent).see ? agent : null;
  }

  app.get("/", async (c) => {
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "scope must be team, personal or gallery.");
    const scopes: AgentScope[] = query.data.scope
      ? [query.data.scope]
      : ["team", "personal", "gallery"];
    const actor = actorOf(c);
    const archived = query.data.include_archived === "true";
    const lists = await Promise.all(scopes.map((s) => listAgents(db, locationFor(c, s))));
    const agents = lists
      .flat()
      .filter((agent) => archived || agent.archivedAt === null)
      .map((agent) => ({ agent, access: agentAccess(actor, agent) }))
      .filter(({ access }) => access.see)
      .map(({ agent, access }) => agentSummary(agent, access));
    return c.json({ agents });
  });

  // Agents the caller can start a chat with (KOBE-122): before "/:id".
  app.get("/runnable", async (c) => {
    const query = runnableQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "Check limit and cursor.");
    const viewer = { teamId: c.get("team").id, userId: c.get("user").id };
    return c.json(await listRunnableAgents(db, viewer, query.data));
  });

  // Rosters (KOBE-566): `/roster` before "/:id"; assignments under "/:id/assignments".
  mountAgentRosterRoutes(app, deps);
  // Transfers (KOBE-568): `/transfers` before "/:id"; offers under "/:id/transfer".
  mountAgentTransferRoutes(app, deps);

  // Published Orbit scores of gallery agents (KOBE-94): before "/:id".
  app.get("/gallery-scores", async (c) => {
    const scores = await currentGalleryScores(db);
    return c.json({ scores: scores.map(galleryScoreView) });
  });

  // Team admins' inventory (KOBE-86): before "/:id" so "inventory" is not read as an id.
  app.get("/inventory", async (c) => {
    if (!teamRoleAllows(c.get("team").role, "team.agents.suspend")) {
      return forbidden(c, "Only team admins see the agent inventory.");
    }
    const query = inventoryQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "Check limit and cursor.");
    const page = await listInventory(db, c.get("team").id, query.data);
    const actor = actorOf(c);
    return c.json({
      ...page,
      // Per row: exporting needs the right to read that agent's definition (KOBE-91).
      agents: page.agents.map((a) => ({
        ...a,
        canExport: agentAccess(actor, { scope: a.scope, ownerUserId: a.ownerUserId })
          .readDefinition,
      })),
    });
  });

  app.put("/inventory/:id/status", async (c) => {
    if (!teamRoleAllows(c.get("team").role, "team.agents.suspend")) {
      return forbidden(c, "Only team admins suspend agents.");
    }
    const id = agentIdSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, agentStatusSchema);
    if (!body) return invalidRequest(c, "status must be active or suspended.");
    if (!id.success) return notFound(c);
    const result = await setInventoryStatus(
      db,
      c.get("team").id,
      c.get("user").id,
      id.data,
      body.status,
    );
    if (!result.ok) return notFound(c);
    return c.json({ id: id.data, scope: result.scope, status: body.status });
  });

  app.post("/", agentBodyLimit, async (c) => {
    const input = await readAgentInput(c);
    if (!input.ok) return input.response;
    const meta = createMetaSchema.safeParse(input.meta);
    if (!meta.success)
      return invalidRequest(c, "Give scope (team or personal) and optionally a slug.");
    if (!canCreateAgent(c.get("team").role, meta.data.scope)) {
      return forbidden(c, "Your team role doesn't allow creating team agents.");
    }
    const dangerous = refuseDangerous(c, input.definition);
    if (dangerous) return dangerous;
    const result = await createAgent(db, locationFor(c, meta.data.scope), {
      definition: input.definition,
      slug: meta.data.slug,
      baseSlug: slugFromName(input.definition.frontmatter.name),
      ownerUserId: c.get("user").id,
      source: input.source,
    });
    if (!result.ok) return createError(c, result.error);
    return agentResponse(c, result.value, agentAccess(actorOf(c), result.value), 201);
  });

  /** Someone else's personal agent read from a roster (KOBE-571, AR14), or null. */
  async function rosterRead(c: Ctx) {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return null;
    // `?from=site` (the Site tab's View) shows the site entry's version in effect (KOBE-571).
    const from = c.req.query("from") === "site" ? "site" : "team";
    return rosterDefinitionRead(db, { ...actorOf(c), teamId: c.get("team").id }, id.data, from);
  }

  app.get("/:id", async (c) => {
    const agent = await visible(c);
    if (!agent) return (await rosterView(c)) ?? offeredAgent(c);
    const access = agentAccess(actorOf(c), agent);
    if (!access.readDefinition) return c.json({ agent: agentSummary(agent, access) });
    if (agent.scope !== "personal") return agentResponse(c, agent, access);
    // The owner sees a pending transfer of their agent (KOBE-568, AR10).
    c.header("ETag", etag(agent));
    return c.json({
      agent: agentDetail(agent, access),
      warnings: agentWarnings(agent.frontmatter),
      transfer: await pendingTransfer(db, agent.id),
    });
  });

  /**
   * View from a roster (AR14): the version in effect, read-only, with `versionInEffect` on the
   * agent so the editor says what it shows.
   */
  async function rosterView(c: Ctx): Promise<Response | null> {
    const read = await rosterRead(c);
    if (!read) return null;
    return c.json({
      agent: {
        ...agentDetail(read.agent, ROSTER_READ_ACCESS),
        // Read-only: no export of someone else's agent from a View (owner's Orbit export, KOBE-91).
        canExport: false,
        versionInEffect: read.versionInEffect,
      },
      warnings: agentWarnings(read.agent.frontmatter),
    });
  }

  /** The recipient of a pending transfer reads the offered agent's summary with the offer. */
  async function offeredAgent(c: Ctx): Promise<Response> {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    const transfer = id.success ? await pendingTransfer(db, id.data) : null;
    if (!transfer || transfer.toUserId !== c.get("user").id) return notFound(c);
    const offered = await findAgent(
      db,
      { scope: "personal", ownerUserId: transfer.fromUserId },
      transfer.agentId,
    );
    if (!offered) return notFound(c);
    return c.json({ agent: agentSummary(offered, NO_ACCESS), transfer });
  }

  app.get("/:id/export", async (c) => {
    const agent = await visible(c);
    if (!agent) return notFound(c);
    if (!agentAccess(actorOf(c), agent).readDefinition) {
      return forbidden(c, "Your team role doesn't allow exporting team agents.");
    }
    await recordAuditAfter(db, {
      action: "agent.exported",
      teamId: agent.scope === "team" ? c.get("team").id : null,
      target: { agentId: agent.id, scope: agent.scope, slug: agent.slug },
    });
    return exportResponse(c, agent);
  });

  app.put("/:id", agentBodyLimit, async (c) => {
    const agent = await visible(c);
    if (!agent) return notFound(c);
    const access = agentAccess(actorOf(c), agent);
    if (!access.edit) return forbidden(c);
    const ifMatch = ifMatchRevision(c);
    if (!ifMatch.ok) return ifMatch.response;
    const input = await readAgentInput(c);
    if (!input.ok) return input.response;
    if (!updateMetaSchema.safeParse(input.meta).success) {
      return invalidRequest(c, "Send only frontmatter and prompt; slugs can't change.");
    }
    const dangerous = refuseDangerous(c, input.definition);
    if (dangerous) return dangerous;
    const result = await updateAgent(
      db,
      locationFor(c, agent.scope),
      agent.id,
      input.definition,
      ifMatch.revision,
      input.source,
    );
    if (!result.ok) {
      if (result.error === "archived") return archivedConflict(c);
      return result.error === "not_found" ? notFound(c) : preconditionFailed(c);
    }
    return agentResponse(c, result.value, access);
  });

  /** Never published: deleted (204). Published: archived (200), its versions stay pinned. */
  app.delete("/:id", async (c) => {
    const agent = await visible(c);
    if (!agent) return notFound(c);
    const access = agentAccess(actorOf(c), agent);
    if (!access.edit) return forbidden(c);
    // A never-published personal agent on a roster (or proposed) is not deleted (§6.3).
    const guard = agent.scope === "personal" ? () => refuseIfRostered(db, agent.id) : undefined;
    let removed;
    try {
      removed = await deleteOrArchiveAgent(
        db,
        locationFor(c, agent.scope),
        agent.id,
        undefined,
        null,
        guard,
      );
    } catch (err) {
      if (err instanceof AgentRosteredError) return rosterError(c, "agent_rostered");
      throw err;
    }
    if (!removed) return notFound(c);
    return removed.kind === "deleted" ? c.body(null, 204) : agentResponse(c, removed.agent, access);
  });

  /**
   * Fork (KOBE-568, agents-roster AR8, §6.7): always a personal agent of the caller's, from the
   * source's published version (or the draft of their own unpublished agent), with fork provenance
   * and, for team content, bound to that team.
   */
  app.post("/:id/fork", async (c) => {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = await parseBody(c, forkSchema);
    if (!body) return invalidRequest(c, "Give optionally a slug.");
    const actor = actorOf(c);
    const caller = { teamId: c.get("team").id, userId: actor.userId };
    const source = await findForkSource(db, caller, id.data);
    if (!source) return notFound(c);
    if (!canForkAgent(actor, source.via)) return forbidden(c, "You can't copy this agent.");
    const copied = await forkDefinition(db, source);
    if (!copied)
      return rosterError(c, "agent_not_published", "This agent has no published version yet.");
    const boundTeamId = forkBinding(source.via, source.boundTeamId, caller.teamId);
    const definition = forkable(c, copied.definition);
    const named =
      body.name === undefined
        ? definition
        : { ...definition, frontmatter: { ...definition.frontmatter, name: body.name } };
    const result = await createAgent(db, locationFor(c, "personal"), {
      definition: named,
      slug: body.slug,
      baseSlug: source.agent.slug,
      ownerUserId: actor.userId,
      source: "fork",
      forkedFrom: source.agent.id,
      forkedFromVersion: copied.version,
      boundTeamId,
    });
    if (!result.ok) return createError(c, result.error);
    const fork = result.value;
    c.header("ETag", etag(fork));
    return c.json(
      {
        agent: agentDetail(fork, agentAccess(actor, fork)),
        boundTeamId,
        warnings: [
          ...agentWarnings(fork.frontmatter),
          ...(body.scope === undefined ? [] : [AGENT_FORK_SCOPE_IGNORED]),
        ],
      },
      201,
    );
  });

  app.put("/:id/status", async (c) => {
    const agent = await visible(c);
    if (!agent) return notFound(c);
    const body = await parseBody(c, agentStatusSchema);
    if (!body) return invalidRequest(c, "status must be active or suspended.");
    const access = agentAccess(actorOf(c), agent);
    if (!access.setStatus) return forbidden(c, "Only team admins suspend team agents.");
    const updated = await setAgentStatus(db, locationFor(c, agent.scope), agent.id, body.status);
    if (!updated) return notFound(c);
    return agentResponse(c, updated, access);
  });

  const resolveVersioned = async (raw: Context) => {
    const c = raw as Ctx;
    const agent = await visible(c);
    if (!agent) return null;
    return {
      agent,
      location: locationFor(c, agent.scope),
      access: agentAccess(actorOf(c), agent),
    };
  };
  const resolveReadable = async (raw: Context) => {
    const found = await resolveVersioned(raw);
    if (found) return found;
    const read = await rosterRead(raw as Ctx);
    return read ? { agent: read.agent, location: read.location, access: ROSTER_READ_ACCESS } : null;
  };
  mountVersionRoutes(app, {
    db,
    limits: deps.agentLimits,
    resolve: resolveVersioned,
    resolveRead: resolveReadable,
    userId: (c) => (c as Ctx).get("user").id,
    mayUseDangerousMode: (c) => mayDangerous(c as Ctx),
    evals: {
      runner: evalOptions.runner,
      // A getter: read-only requests never touch deps.background (threads.db.test.ts checks).
      get background() {
        return deps.background;
      },
      team: (c) => ({ id: (c as Ctx).get("team").id, slug: (c as Ctx).get("team").slug }),
    },
  });
  mountEvalRoutes(app, {
    db,
    resolve: resolveVersioned,
    teamId: (c) => (c as Ctx).get("team").id,
  });
  mountOrbitExport(app, {
    db,
    resolve: resolveVersioned,
    teamId: (c) => (c as Ctx).get("team").id,
  });
  // Answer ratings per version (KOBE-275): owners and team admins.
  mountFeedbackTotals(app, {
    db,
    resolve: resolveVersioned,
    teamId: (c) => (c as Ctx).get("team").id,
    role: (c) => (c as Ctx).get("team").role,
    userId: (c) => (c as Ctx).get("user").id,
  });
  // Shared eval cases (KOBE-276): the agent's owner only.
  mountAgentEvalCases(app, {
    db,
    resolve: resolveVersioned,
    teamId: (c) => (c as Ctx).get("team").id,
    userId: (c) => (c as Ctx).get("user").id,
  });

  return app;
}
