import { Hono, type Context } from "hono";
import { GALLERY_ADMIN_ACCESS } from "../agents/access.js";
import { agentResponse, agentSummary, exportResponse, notFound } from "../agents/http.js";
import { agentIdSchema } from "../agents/schemas.js";
import { findAgent, listAgents, type AgentLocation, type AgentRecord } from "../agents/store.js";
import type { AuthVariables } from "../auth/session.js";
import { recordAuditAfter } from "../audit/record.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

const GALLERY: AgentLocation = { scope: "gallery" };

/**
 * Gallery agents for install admins (spec D6, D19, D21; §6.1 `/v1/install/gallery`): a read-only
 * view. Gallery agents are seeded from definitions in the repo at install and upgrade
 * (`gallery/seed.ts`, KOBE-87), so every write method answers 405 `gallery_read_only`, whoever
 * asks; teams use gallery agents through `/v1/agents` and fork them to change them.
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

  app.on(["POST", "PUT", "PATCH", "DELETE"], "*", (c) =>
    c.json(
      {
        code: "gallery_read_only",
        message:
          "Gallery agents come from the repository's definitions and change only with a release. Teams fork them to edit.",
      },
      405,
    ),
  );

  return app;
}
