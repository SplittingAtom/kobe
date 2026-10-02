import { Hono, type Context } from "hono";
import { slugFromName } from "@kobe/agent-file";
import {
  agentAccess,
  canCreateAgent,
  canForkAgent,
  type AgentActor,
  type AgentScope,
} from "../agents/access.js";
import {
  agentBodyLimit,
  agentDefinitionOf,
  agentResponse,
  agentSummary,
  archivedConflict,
  createError,
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
  findVisibleAgent,
  listAgents,
  setAgentStatus,
  updateAgent,
  type AgentLocation,
  type AgentRecord,
} from "../agents/store.js";
import { mountVersionRoutes } from "../agents/version-routes.js";
import { deleteOrArchiveAgent, getVersion } from "../agents/versions.js";
import { recordAuditAfter } from "../audit/record.js";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { parseBody } from "../teams/http.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const actorOf = (c: Ctx): AgentActor => ({ userId: c.get("user").id, role: c.get("team").role });

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
 * `/v1/install/gallery/agents`.
 */
export function agentRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
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

  app.post("/", agentBodyLimit, async (c) => {
    const input = await readAgentInput(c);
    if (!input.ok) return input.response;
    const meta = createMetaSchema.safeParse(input.meta);
    if (!meta.success)
      return invalidRequest(c, "Give scope (team or personal) and optionally a slug.");
    if (!canCreateAgent(c.get("team").role, meta.data.scope)) {
      return forbidden(c, "Your team role doesn't allow creating team agents.");
    }
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

  app.get("/:id", async (c) => {
    const agent = await visible(c);
    if (!agent) return notFound(c);
    const access = agentAccess(actorOf(c), agent);
    if (!access.readDefinition) return c.json({ agent: agentSummary(agent, access) });
    return agentResponse(c, agent, access);
  });

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
    const removed = await deleteOrArchiveAgent(db, locationFor(c, agent.scope), agent.id);
    if (!removed) return notFound(c);
    return removed.kind === "deleted" ? c.body(null, 204) : agentResponse(c, removed.agent, access);
  });

  app.post("/:id/fork", async (c) => {
    const source = await visible(c);
    if (!source) return notFound(c);
    const body = await parseBody(c, forkSchema);
    if (!body) return invalidRequest(c, "Give scope (team or personal) and optionally a slug.");
    if (!canForkAgent(actorOf(c), source, body.scope)) {
      return forbidden(c, "You can't copy this agent there.");
    }
    // A gallery agent forks from what it published, not from the curators' work in progress.
    const published =
      source.scope === "gallery" && source.currentVersion !== null
        ? await getVersion(db, { scope: "gallery" }, source.id, source.currentVersion)
        : null;
    const result = await createAgent(db, locationFor(c, body.scope), {
      definition: published?.definition ?? agentDefinitionOf(source),
      slug: body.slug,
      baseSlug: source.slug,
      ownerUserId: c.get("user").id,
      source: "fork",
      forkedFrom: source.id,
    });
    if (!result.ok) return createError(c, result.error);
    return agentResponse(c, result.value, agentAccess(actorOf(c), result.value), 201);
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

  mountVersionRoutes(app, {
    db,
    resolve: async (raw) => {
      const c = raw as Ctx;
      const agent = await visible(c);
      if (!agent) return null;
      return {
        agent,
        location: locationFor(c, agent.scope),
        access: agentAccess(actorOf(c), agent),
      };
    },
    userId: (c) => (c as Ctx).get("user").id,
  });

  return app;
}
