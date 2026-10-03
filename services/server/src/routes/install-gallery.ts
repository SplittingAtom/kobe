import { Hono, type Context } from "hono";
import { slugFromName } from "@kobe/agent-file";
import { GALLERY_ADMIN_ACCESS } from "../agents/access.js";
import {
  agentBodyLimit,
  agentResponse,
  agentSummary,
  archivedConflict,
  createError,
  exportResponse,
  invalidRequest,
  notFound,
  preconditionFailed,
  readAgentInput,
  ifMatchRevision,
} from "../agents/http.js";
import {
  agentIdSchema,
  agentStatusSchema,
  galleryCreateMetaSchema,
  updateMetaSchema,
} from "../agents/schemas.js";
import {
  createAgent,
  findAgent,
  listAgents,
  setAgentStatus,
  updateAgent,
  type AgentLocation,
  type AgentRecord,
} from "../agents/store.js";
import { mountVersionRoutes } from "../agents/version-routes.js";
import { deleteOrArchiveAgent } from "../agents/versions.js";
import type { AuthVariables } from "../auth/session.js";
import { recordAuditAfter } from "../audit/record.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { parseBody } from "../teams/http.js";

const GALLERY: AgentLocation = { scope: "gallery" };

/**
 * Gallery agents (spec D6, D19, D21; §6.1 `/v1/install/gallery`): install-wide, curated by install
 * admins, read-only to teams (which fork them). Same bodies as `/v1/agents`: JSON or an agent
 * markdown file. No team is involved, so no active team or X-Kobe-Team header.
 */
export function installGalleryRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.gallery.manage"));

  async function galleryAgent(c: Context): Promise<AgentRecord | null> {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    return id.success ? findAgent(db, GALLERY, id.data) : null;
  }

  app.get("/", async (c) => {
    const agents = await listAgents(db, GALLERY);
    return c.json({ agents: agents.map((a) => agentSummary(a, GALLERY_ADMIN_ACCESS)) });
  });

  app.post("/", agentBodyLimit, async (c) => {
    const input = await readAgentInput(c);
    if (!input.ok) return input.response;
    const meta = galleryCreateMetaSchema.safeParse(input.meta);
    if (!meta.success) return invalidRequest(c, "Only an optional slug may accompany the agent.");
    const result = await createAgent(db, GALLERY, {
      definition: input.definition,
      slug: meta.data.slug,
      baseSlug: slugFromName(input.definition.frontmatter.name),
      ownerUserId: null,
      source: input.source,
    });
    if (!result.ok) return createError(c, result.error);
    return agentResponse(c, result.value, GALLERY_ADMIN_ACCESS, 201);
  });

  app.get("/:id", async (c) => {
    const agent = await galleryAgent(c);
    return agent ? agentResponse(c, agent, GALLERY_ADMIN_ACCESS) : notFound(c);
  });

  app.get("/:id/export", async (c) => {
    const agent = await galleryAgent(c);
    if (!agent) return notFound(c);
    await recordAuditAfter(db, {
      action: "agent.exported",
      target: { agentId: agent.id, scope: "gallery", slug: agent.slug },
    });
    return exportResponse(c, agent);
  });

  app.put("/:id", agentBodyLimit, async (c) => {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const ifMatch = ifMatchRevision(c);
    if (!ifMatch.ok) return ifMatch.response;
    const input = await readAgentInput(c);
    if (!input.ok) return input.response;
    if (!updateMetaSchema.safeParse(input.meta).success) {
      return invalidRequest(c, "Send only frontmatter and prompt; slugs can't change.");
    }
    const result = await updateAgent(
      db,
      GALLERY,
      id.data,
      input.definition,
      ifMatch.revision,
      input.source,
    );
    if (!result.ok) {
      if (result.error === "archived") return archivedConflict(c);
      return result.error === "not_found" ? notFound(c) : preconditionFailed(c);
    }
    return agentResponse(c, result.value, GALLERY_ADMIN_ACCESS);
  });

  /** Never published: deleted (204). Published: archived (200); teams' pinned threads keep it. */
  app.delete("/:id", async (c) => {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    const removed = id.success ? await deleteOrArchiveAgent(db, GALLERY, id.data) : null;
    if (!removed) return notFound(c);
    return removed.kind === "deleted"
      ? c.body(null, 204)
      : agentResponse(c, removed.agent, GALLERY_ADMIN_ACCESS);
  });

  app.put("/:id/status", async (c) => {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = await parseBody(c, agentStatusSchema);
    if (!body) return invalidRequest(c, "status must be active or suspended.");
    const updated = await setAgentStatus(db, GALLERY, id.data, body.status);
    return updated ? agentResponse(c, updated, GALLERY_ADMIN_ACCESS) : notFound(c);
  });

  mountVersionRoutes(app, {
    db,
    limits: deps.agentLimits,
    resolve: async (c) => {
      const agent = await galleryAgent(c);
      return agent ? { agent, location: GALLERY, access: GALLERY_ADMIN_ACCESS } : null;
    },
    userId: (c) => (c as Context<{ Variables: AuthVariables }>).get("user").id,
  });

  return app;
}
