import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";
import {
  addMaintainer,
  listMaintainers,
  MAINTAINERS_MAX,
  reassignMaintainers,
  removeMaintainer,
  type MaintainerResult,
} from "../skills/registry/maintainers.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const idSchema = z.uuid();
const addSchema = z.strictObject({ userId: z.uuid() });
const reassignSchema = z.strictObject({ userIds: z.array(z.uuid()).min(1).max(MAINTAINERS_MAX) });

type Ctx = Context<{ Variables: AuthVariables }>;

const STATUS = {
  not_found: 404,
  user_not_found: 404,
  forbidden: 403,
  kobe_skill: 403,
  last_maintainer: 409,
  too_many: 400,
} as const;

function answer(c: Ctx, r: MaintainerResult) {
  if (r.ok) return c.json({ maintainers: r.maintainers });
  return c.json({ code: r.code, message: r.message }, STATUS[r.code]);
}

/**
 * Catalog skill maintainers (`/v1/skills/catalog/:skillId/maintainers`, KOBE-332, SK24): anyone
 * signed in reads them (the catalog is Site-wide); its active maintainers and Site admins add and
 * remove; Site admins reassign the list. Every change is audited.
 */
export function catalogMaintainerRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  const actor = (c: Ctx) => ({ userId: c.get("user").id, siteRole: c.get("siteRole") });
  const skillId = (c: Ctx) => idSchema.safeParse(c.req.param("skillId"));

  app.get("/:skillId/maintainers", async (c) => {
    const id = skillId(c);
    if (!id.success) return c.json({ code: "not_found", message: "No such skill." }, 404);
    return c.json({ maintainers: await listMaintainers(db, id.data) });
  });

  app.post("/:skillId/maintainers", async (c) => {
    const id = skillId(c);
    const body = await parseBody(c, addSchema);
    if (!id.success || !body) return invalidRequest(c, "Send the userId to add.");
    return answer(c, await addMaintainer(db, id.data, body.userId, actor(c)));
  });

  app.delete("/:skillId/maintainers/:userId", async (c) => {
    const id = skillId(c);
    const user = idSchema.safeParse(c.req.param("userId"));
    if (!id.success || !user.success) return invalidRequest(c);
    return answer(c, await removeMaintainer(db, id.data, user.data, actor(c)));
  });

  app.put("/:skillId/maintainers", async (c) => {
    const id = skillId(c);
    const body = await parseBody(c, reassignSchema);
    if (!id.success || !body) return invalidRequest(c, `Send 1 to ${MAINTAINERS_MAX} userIds.`);
    return answer(c, await reassignMaintainers(db, id.data, body.userIds, actor(c)));
  });

  return app;
}
