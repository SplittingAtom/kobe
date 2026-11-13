import { Hono } from "hono";
import type { Context } from "hono";
import type { z } from "zod";
import {
  createSemanticMemoryItemSchema,
  patchSemanticMemoryItemSchema,
  pinSemanticMemoryItemSchema,
  revertSemanticMemoryItemSchema,
  semanticMemoryItemActionSchema,
  semanticMemoryListQuerySchema,
  semanticMemoryScopeSchema,
  type SemanticMemoryScope,
} from "@kobe/protocol";
import {
  TEAM_HEADER,
  readActiveTeamId,
  requireTeam,
  type ActiveTeam,
  type TeamVariables,
} from "../authz/middleware.js";
import { teamRoleAllows } from "../authz/permissions.js";
import { delegationOf } from "../kobe-mcp/delegation.js";
import type { ServerDeps } from "../deps.js";
import { createItem } from "../memory/items/create.js";
import { archiveItem, patchItem, pinItem, restoreItem, revertItem } from "../memory/items/edit.js";
import { MemoryItemError } from "../memory/items/errors.js";
import { getItem, listItems } from "../memory/items/read.js";
import type { MemoryWho } from "../memory/items/who.js";
import { isWorkspaceSteward } from "../memory/stewards.js";
import { grantsOf } from "../skills/registry/grants.js";
import { invalidRequest } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const issueText = (e: z.ZodError) =>
  e.issues
    .slice(0, 3)
    .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");

/**
 * Semantic memory items (`/v1/memory/semantic/items`, KOBE-378; contract KOBE-377 in
 * `@kobe/protocol` semantic-memory/items.ts, store in `memory/items/`). `user` and `team` routes
 * run in the active Workspace; portable and Site routes need none (see resolveTeam). The store
 * decides per scope who reads and who writes
 * (KOBE-380 permissions, the Policy guard) and which switches apply (KOBE-381).
 */
export function memoryItemRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  /**
   * The Workspace a request runs in. `user` and `team` items need the active Workspace
   * (`requireTeam`: header, membership). Portable and Site items don't (Site admins and stewards
   * may belong to none): with an active Workspace (or a team header, or an admin-tool delegation)
   * it is resolved the same way and its switches apply; without one only the Site's do.
   */
  const resolveTeam = async (c: Ctx, scope: SemanticMemoryScope): Promise<Response | undefined> => {
    if (scope !== "user" && scope !== "team") {
      const named =
        c.req.header(TEAM_HEADER) !== undefined ||
        delegationOf(c) !== undefined ||
        (await readActiveTeamId(deps, c.get("sessionId"))) !== null;
      if (!named) return undefined;
    }
    let passed = false;
    const refused = await requireTeam(deps)(c, async () => {
      passed = true;
    });
    if (!passed)
      return refused ?? c.json({ code: "no_active_team", message: "Choose a team first." }, 409);
    if (!teamRoleAllows(c.get("team").role, "team.chat"))
      return c.json({ code: "forbidden", message: "Your team role doesn't allow that." }, 403);
    return undefined;
  };

  const whoOf = async (c: Ctx): Promise<MemoryWho> => {
    const userId = c.get("user").id;
    const team = c.var.team as ActiveTeam | undefined;
    return {
      userId,
      teamId: team?.id ?? null,
      teamRole: team?.role ?? null,
      memorySteward: team ? await isWorkspaceSteward(db, team.id, userId) : false,
      siteRole: c.get("siteRole"),
      grants: await grantsOf(db, userId),
    };
  };

  /** Resolves the Workspace, runs a store call and maps refusals to the contract's answers. */
  const answer = async (
    c: Ctx,
    scope: SemanticMemoryScope,
    fn: (who: MemoryWho) => Promise<object>,
    status: 200 | 201 = 200,
  ) => {
    const refused = await resolveTeam(c, scope);
    if (refused) return refused;
    try {
      return c.json(await fn(await whoOf(c)), status);
    } catch (err) {
      if (!(err instanceof MemoryItemError)) throw err;
      return c.json(err.body(), err.status as 400);
    }
  };

  const readBody = async <T>(c: Ctx, schema: z.ZodType<T>, optional = false) => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    return schema.safeParse(raw === undefined && optional ? {} : raw);
  };

  /** Scope and id of an item route, or a 400 response. */
  const target = (c: Ctx): { scope: SemanticMemoryScope; id: string } | Response => {
    const scope = semanticMemoryScopeSchema.safeParse(c.req.param("scope"));
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!scope.success) return invalidRequest(c, "scope must be user, portable, team or site.");
    if (!id.success) return invalidRequest(c, "id must be a memory id.");
    return { scope: scope.data, id: id.data };
  };

  app.get("/", async (c) => {
    const q = semanticMemoryListQuerySchema.safeParse(c.req.query());
    if (!q.success) return invalidRequest(c, issueText(q.error));
    return answer(c, q.data.scope, (who) => listItems(db, who, q.data));
  });

  app.post("/", async (c) => {
    const body = await readBody(c, createSemanticMemoryItemSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, body.data.scope, (who) => createItem(db, who, body.data), 201);
  });

  app.get("/:scope/:id", async (c) => {
    const t = target(c);
    if (t instanceof Response) return t;
    return answer(c, t.scope, (who) => getItem(db, who, t.scope, t.id));
  });

  app.patch("/:scope/:id", async (c) => {
    const t = target(c);
    if (t instanceof Response) return t;
    const body = await readBody(c, patchSemanticMemoryItemSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, t.scope, (who) => patchItem(db, who, t.scope, t.id, body.data));
  });

  app.post("/:scope/:id/archive", async (c) => {
    const t = target(c);
    if (t instanceof Response) return t;
    const body = await readBody(c, semanticMemoryItemActionSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, t.scope, (who) => archiveItem(db, who, t.scope, t.id, body.data));
  });

  app.post("/:scope/:id/restore", async (c) => {
    const t = target(c);
    if (t instanceof Response) return t;
    const body = await readBody(c, semanticMemoryItemActionSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, t.scope, (who) => restoreItem(db, who, t.scope, t.id, body.data));
  });

  app.post("/:scope/:id/revert", async (c) => {
    const t = target(c);
    if (t instanceof Response) return t;
    const body = await readBody(c, revertSemanticMemoryItemSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, t.scope, (who) => revertItem(db, who, t.scope, t.id, body.data));
  });

  app.post("/:scope/:id/pin", async (c) => {
    const t = target(c);
    if (t instanceof Response) return t;
    const body = await readBody(c, pinSemanticMemoryItemSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, t.scope, (who) => pinItem(db, who, t.scope, t.id, body.data));
  });

  return app;
}
