import { Hono, type Context } from "hono";
import { z } from "zod";
import { GALLERY_ADMIN_ACCESS } from "../agents/access.js";
import {
  agentResponse,
  agentSummary,
  exportResponse,
  invalidRequest,
  notFound,
} from "../agents/http.js";
import { evalView } from "../agents/eval/routes.js";
import { currentGalleryScores, galleryScoreView } from "../agents/eval/gallery-scores.js";
import { startGalleryEval } from "../agents/eval/gallery-start.js";
import type { EvalRunner } from "../agents/eval/service.js";
import { agentIdSchema } from "../agents/schemas.js";
import { findAgent, listAgents, type AgentLocation, type AgentRecord } from "../agents/store.js";
import type { AuthVariables } from "../auth/session.js";
import { recordAuditAfter } from "../audit/record.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

const GALLERY: AgentLocation = { scope: "gallery" };
const bodySchema = z.object({ teamId: z.uuid() }).strict();

/**
 * Gallery agents for install admins (spec D6, D19, D21; §6.1 `/v1/install/gallery`): a read-only
 * view. Gallery agents are seeded from definitions in the repo at install and upgrade
 * (`gallery/seed.ts`, KOBE-87), so every write method answers 405 `gallery_read_only`, whoever
 * asks; teams use gallery agents through `/v1/agents` and fork them to change them.
 */
export function installGalleryRoutes(
  deps: ServerDeps,
  evalOptions: { readonly runner?: EvalRunner } = {},
): Hono<{ Variables: AuthVariables }> {
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

  // Published Orbit scores (KOBE-94), before "/:id".
  app.get("/scores", async (c) => {
    const scores = await currentGalleryScores(db);
    return c.json({ scores: scores.map(galleryScoreView) });
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
