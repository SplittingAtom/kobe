import { Hono, type Context } from "hono";
import { agentWarnings, isDangerousMode } from "@kobe/agent-file";
import { z } from "zod";
import { GALLERY_ADMIN_ACCESS } from "../agents/access.js";
import {
  agentBodyLimit,
  agentDetail,
  agentSummary,
  archivedConflict,
  etag,
  exportResponse,
  ifMatchRevision,
  invalidRequest,
  notFound,
  preconditionFailed,
  readAgentInput,
} from "../agents/http.js";
import { evalView } from "../agents/eval/routes.js";
import { currentGalleryScores, galleryScoreView } from "../agents/eval/gallery-scores.js";
import { startGalleryEval } from "../agents/eval/gallery-start.js";
import type { EvalRunner } from "../agents/eval/service.js";
import { agentIdSchema, updateMetaSchema } from "../agents/schemas.js";
import {
  findAgent,
  listAgents,
  updateAgent,
  type AgentLocation,
  type AgentRecord,
} from "../agents/store.js";
import { mountVersionRoutes } from "../agents/version-routes.js";
import type { AuthVariables } from "../auth/session.js";
import { recordAuditAfter } from "../audit/record.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  clearCustomized,
  compareWithRepository,
  galleryState,
  galleryStates,
  markCustomized,
  repositoryDefinition,
  type GalleryState,
} from "../gallery/customization.js";
import { seedGalleryAgent } from "../gallery/seed.js";
import { listGalleryConnectors } from "../connectors/team-store.js";
import { listCatalog } from "../models/admin-store.js";
import { logger } from "../logger.js";
import { DANGEROUS_FORBIDDEN, mayUseDangerousMode } from "../policy/dangerous-mode.js";

const GALLERY: AgentLocation = { scope: "gallery" };
const bodySchema = z.object({ teamId: z.uuid() }).strict();

/** Site admins edit and publish gallery agents (KOBE-494); suspension stays per team. */
const GALLERY_EDITOR_ACCESS = {
  ...GALLERY_ADMIN_ACCESS,
  edit: true,
  publish: true,
} as const;

const NOT_CUSTOMIZED = {
  code: "not_customized",
  message: "This gallery agent already follows the repository definition.",
} as const;

const readOnly = (c: Context) =>
  c.json(
    {
      code: "gallery_read_only",
      message:
        "Gallery agents come from the repository's definitions: they can be edited and published here, not created, deleted, suspended or unarchived.",
    },
    405,
  );

/** The agent with its definition and where it stands against the repo (KOBE-494). */
function galleryResponse(c: Context, agent: AgentRecord, gallery: GalleryState | null) {
  c.header("ETag", etag(agent));
  return c.json({
    agent: { ...agentDetail(agent, GALLERY_EDITOR_ACCESS), gallery },
    warnings: agentWarnings(agent.frontmatter),
  });
}

/**
 * Gallery agents for site admins (spec D6, D19, D21; §6.1 `/v1/site/gallery`). Seeded from
 * definitions in the repo at install and upgrade (`gallery/seed.ts`, KOBE-87). Since KOBE-494
 * (D19/D21 amended by Chris 2026-10-23) site admins save drafts and publish them here (new
 * immutable versions, D19); the first edit marks the agent Customized, which the seed then skips,
 * and Reset to repository re-attaches it. `site.gallery.manage` is checked on every request.
 * Creating, deleting, suspending and unarchiving still answer 405 `gallery_read_only`; teams use
 * gallery agents through `/v1/agents` and fork them.
 */
export function siteGalleryRoutes(
  deps: ServerDeps,
  evalOptions: { readonly runner?: EvalRunner } = {},
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireSitePermission("site.gallery.manage"));

  async function galleryAgent(c: Context): Promise<AgentRecord | null> {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    return id.success ? findAgent(db, GALLERY, id.data) : null;
  }

  app.get("/", async (c) => {
    const [agents, states] = await Promise.all([listAgents(db, GALLERY), galleryStates(db)]);
    return c.json({
      agents: agents.map((a) => ({
        ...agentSummary(a, GALLERY_EDITOR_ACCESS),
        gallery: states.get(a.id) ?? null,
      })),
    });
  });

  // Published Orbit scores (KOBE-94), before "/:id".
  app.get("/scores", async (c) => {
    const scores = await currentGalleryScores(db);
    return c.json({ scores: scores.map(galleryScoreView) });
  });

  // What the gallery agent editor offers (KOBE-494): the site's models and active connectors.
  app.get("/builder-options", async (c) => {
    const [catalog, connectors] = await Promise.all([listCatalog(db), listGalleryConnectors(db)]);
    return c.json({
      models: {
        models: catalog.map((m) => ({ ...m, enabled: true, is_default: false })),
        default: null,
      },
      connectors,
    });
  });

  app.get("/:id", async (c) => {
    const agent = await galleryAgent(c);
    return agent ? galleryResponse(c, agent, await galleryState(db, agent.id)) : notFound(c);
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

  /**
   * Runs the Orbit eval for the agent's current version (KOBE-94) in `teamId`, a team the caller
   * belongs to (its namespace and model budget). 202; the score appears in `/scores` when done.
   */
  app.post("/:id/eval", async (c) => {
    const agent = await galleryAgent(c);
    if (!agent) return notFound(c);
    const body = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalidRequest(c, "Send { teamId }: the team to run the eval in.");
    const started = await startGalleryEval({
      db,
      runner: evalOptions.runner,
      background: deps.background,
      userId: c.get("user").id,
      teamId: body.data.teamId,
      agent,
    });
    if (!started.ok) {
      return c.json({ code: started.code, message: started.message }, started.status);
    }
    return c.json(
      {
        eval: evalView(started.eval),
        message: "Evaluating: the score is published when the eval finishes.",
      },
      202,
    );
  });

  mountEditRoutes(app, deps);
  app.on(["POST", "PUT", "PATCH", "DELETE"], "*", readOnly);

  return app;
}

/**
 * Draft save, publish, versions, Compare and Reset to repository (KOBE-494), reusing the team
 * agents' store and version routes at gallery scope.
 */
function mountEditRoutes(app: Hono<{ Variables: AuthVariables }>, deps: ServerDeps): void {
  const db = deps.database.db;
  const mayDangerous = (c: Context<{ Variables: AuthVariables }>) =>
    mayUseDangerousMode(null, c.get("siteRole"));

  async function galleryAgent(c: Context): Promise<AgentRecord | null> {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    return id.success ? findAgent(db, GALLERY, id.data) : null;
  }

  app.put("/:id", agentBodyLimit, async (c) => {
    const agent = await galleryAgent(c);
    if (!agent) return notFound(c);
    const ifMatch = ifMatchRevision(c);
    if (!ifMatch.ok) return ifMatch.response;
    const input = await readAgentInput(c);
    if (!input.ok) return input.response;
    if (!updateMetaSchema.safeParse(input.meta).success) {
      return invalidRequest(c, "Send only frontmatter and prompt; slugs can't change.");
    }
    if (isDangerousMode(input.definition.frontmatter) && !mayDangerous(c)) {
      return c.json(DANGEROUS_FORBIDDEN, 403);
    }
    const result = await updateAgent(
      db,
      GALLERY,
      agent.id,
      input.definition,
      ifMatch.revision,
      input.source,
    );
    if (!result.ok) {
      if (result.error === "archived") return archivedConflict(c);
      return result.error === "not_found" ? notFound(c) : preconditionFailed(c);
    }
    await markCustomized(db, agent.id, c.get("user").id);
    return galleryResponse(c, result.value, await galleryState(db, agent.id));
  });

  app.get("/:id/compare", async (c) => {
    const agent = await galleryAgent(c);
    if (!agent) return notFound(c);
    const compared = await compareWithRepository(db, agent.id, agent.currentVersion);
    return compared ? c.json(compared) : notFound(c);
  });

  /** Clears the marker and seeds the repo's definition now (a new published version). */
  app.post("/:id/reset", async (c) => {
    const agent = await galleryAgent(c);
    if (!agent) return notFound(c);
    if (agent.archivedAt) return archivedConflict(c);
    if (!(await clearCustomized(db, agent.id))) return c.json(NOT_CUSTOMIZED, 409);
    const state = await galleryState(db, agent.id);
    const definition = state?.key ? repositoryDefinition(state.key) : null;
    if (definition) {
      try {
        await seedGalleryAgent(db, definition);
      } catch (err) {
        // Re-attached all the same: the next start seeds it.
        logger.error({ err, agentId: agent.id }, "gallery agent could not be reset now");
      }
    }
    const fresh = await findAgent(db, GALLERY, agent.id);
    return fresh ? galleryResponse(c, fresh, await galleryState(db, agent.id)) : notFound(c);
  });

  // Unarchiving stays closed (archived gallery agents stay as they are).
  app.post("/:id/unarchive", readOnly);
  mountVersionRoutes(app, {
    db,
    limits: deps.agentLimits,
    resolve: async (c) => {
      const agent = await galleryAgent(c);
      return agent ? { agent, location: GALLERY, access: GALLERY_EDITOR_ACCESS } : null;
    },
    userId: (c) => (c as Context<{ Variables: AuthVariables }>).get("user").id,
    mayUseDangerousMode: (c) => mayDangerous(c as Context<{ Variables: AuthVariables }>),
    onPublished: (c, found) =>
      markCustomized(
        db,
        found.agent.id,
        (c as Context<{ Variables: AuthVariables }>).get("user").id,
      ),
  });
}
