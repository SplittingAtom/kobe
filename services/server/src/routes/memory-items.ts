import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";
import {
  createSemanticMemoryItemSchema,
  patchSemanticMemoryItemSchema,
  pinSemanticMemoryItemSchema,
  restoreSemanticMemoryItemSchema,
  revertSemanticMemoryItemSchema,
  semanticMemoryItemActionSchema,
  semanticMemoryListQuerySchema,
  semanticMemoryScopeSchema,
  type SemanticMemoryScope,
} from "@kobe/protocol";
import {
  requestNamesTeam,
  requireTeam,
  type ActiveTeam,
  type TeamVariables,
} from "../authz/middleware.js";
import { teamRoleAllows } from "../authz/permissions.js";
import { delegationOf } from "../kobe-mcp/delegation.js";
import type { ServerDeps } from "../deps.js";
import { createItem } from "../memory/items/create.js";
import { archiveItem, patchItem, pinItem, restoreItem, revertItem } from "../memory/items/edit.js";
import { MemoryItemError, notAllowed } from "../memory/items/errors.js";
import { AGENT_DETAIL_VIEW, getItem, listItems } from "../memory/items/read.js";
import { assertAgentRead, type MemoryWho } from "../memory/items/who.js";
import { isWorkspaceSteward } from "../memory/stewards.js";
import { grantsOf } from "../skills/registry/grants.js";
import { invalidRequest } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

type Ctx = Context<{ Variables: TeamVariables }>;

export const issueText = (e: z.ZodError) =>
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
  // An agent has no write path to items (KOBE-650): a Kobe admin tool's change is refused before
  // its body or path is read, so it is always 403 (review I1). Reads are checked in `answer`.
  app.use("*", refuseAgentWrites);
  const { answer, readBody } = memoryRouteKit(deps);
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
    const view = delegationOf(c) === undefined ? {} : AGENT_DETAIL_VIEW;
    return answer(c, t.scope, (who) => getItem(db, who, t.scope, t.id, view));
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
    const body = await readBody(c, restoreSemanticMemoryItemSchema, true);
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

/**
 * What every semantic memory route shares (items here, import/export in memory-transfer.ts): the
 * Workspace a request runs in, the caller as the store sees it, refusals mapped to the contract.
 */
export function memoryRouteKit(deps: ServerDeps) {
  const db = deps.database.db;
  /**
   * The Workspace a request runs in. `user` and `team` items need the active Workspace
   * (`requireTeam`: header, membership). Portable and Site items don't (Site admins and stewards
   * may belong to none): with an active Workspace (or a team header, or an admin-tool delegation)
   * it is resolved the same way; Site curators curating Site items get the Site's switches only.
   */
  const resolveTeam = async (c: Ctx, scope: SemanticMemoryScope): Promise<Response | undefined> => {
    if (scope !== "user" && scope !== "team" && !(await requestNamesTeam(deps, c)))
      return undefined;
    let passed = false;
    const refused = await requireTeam(deps)(c, async () => {
      passed = true;
    });
    if (!passed)
      return refused ?? c.json({ code: "no_active_team", message: "Choose a team first." }, 409);
    if (!teamRoleAllows(c.get("team").role, "team.chat"))
      return c.json(
        { code: "memory_not_allowed", message: "Your workspace role doesn't allow that." },
        403,
      );
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

  /**
   * Resolves the Workspace, runs a store call and maps refusals to the contract's answers. A Kobe
   * MCP admin tool's call (KOBE-650) may only read Workspace or Site items its person curates. A
   * route may answer with its own response (an export download).
   */
  const answer = async (
    c: Ctx,
    scope: SemanticMemoryScope,
    fn: (who: MemoryWho) => Promise<object>,
    status: 200 | 201 = 200,
  ) => {
    const refused = await resolveTeam(c, scope);
    if (refused) return refused;
    try {
      const who = await whoOf(c);
      if (delegationOf(c) !== undefined) assertAgentRead(who, scope, c.req.method);
      const out = await fn(who);
      return out instanceof Response ? out : c.json(out, status);
    } catch (err) {
      if (!(err instanceof MemoryItemError)) throw err;
      return c.json(err.body(), err.status as 400);
    }
  };

  const readBody = async <T>(c: Ctx, schema: z.ZodType<T>, optional = false) => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    return schema.safeParse(raw === undefined && optional ? {} : raw);
  };

  return { answer, readBody };
}

/**
 * Agents never change memories (KOBE-650): any non-GET call made through a Kobe admin tool is
 * refused before its body is read. Mounted on the item routes and the import/export routes.
 */
export const refuseAgentWrites: MiddlewareHandler<{ Variables: TeamVariables }> = async (
  c,
  next,
) => {
  if (delegationOf(c) === undefined || c.req.method === "GET" || c.req.method === "HEAD")
    return next();
  const refusal = notAllowed("Agents never change memories: open Memory to change one.");
  return c.json(refusal.body(), 403);
};
