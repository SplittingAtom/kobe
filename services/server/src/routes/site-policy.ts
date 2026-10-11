import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { parseRuleBody, ruleIdParam, ruleLimitReached, ruleNotFound } from "../policy/http.js";
import {
  createSiteRule,
  deleteSiteRule,
  listSiteRules,
  readPromptSandboxWrites,
  updateSiteRule,
  writePromptSandboxWrites,
} from "../policy/rule-store.js";
import { siteRuleBodySchema, SCOPE_LIMITS, policySettingsBodySchema } from "../policy/schemas.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/**
 * The site policy floor (`/v1/site/policy`, spec D6, D8, D29): deny and ask rules that bind
 * every team, and the site's policy switches. Site Owner/Admins only.
 */
export function sitePolicyRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireSitePermission("site.policy.manage"));

  app.get("/rules", async (c) => c.json({ rules: await listSiteRules(db) }));

  app.post("/rules", async (c) => {
    const body = await parseRuleBody(c, siteRuleBodySchema);
    if (!body.ok) return body.response;
    const result = await createSiteRule(db, body.value, c.get("user").id, SCOPE_LIMITS);
    if (!result.ok) return ruleLimitReached(c);
    return c.json({ rule: result.rule }, 201);
  });

  app.put("/rules/:id", async (c) => {
    const id = ruleIdParam(c);
    const body = await parseRuleBody(c, siteRuleBodySchema);
    if (!body.ok) return body.response;
    if (id === undefined) return invalidRequest(c);
    const result = await updateSiteRule(db, id, body.value, SCOPE_LIMITS);
    if (result.ok) return c.json({ rule: result.rule });
    return result.error === "not_found" ? ruleNotFound(c) : ruleLimitReached(c);
  });

  app.delete("/rules/:id", async (c) => {
    const id = ruleIdParam(c);
    if (id === undefined) return invalidRequest(c);
    return (await deleteSiteRule(db, id)) ? c.body(null, 204) : ruleNotFound(c);
  });

  app.get("/settings", async (c) => c.json(await readPromptSandboxWrites(db)));

  app.put("/settings", async (c) => {
    const body = await parseBody(c, policySettingsBodySchema);
    if (!body) return invalidRequest(c, "Send { promptSandboxWrites: boolean }.");
    await writePromptSandboxWrites(db, body.promptSandboxWrites);
    return c.json({ promptSandboxWrites: body.promptSandboxWrites });
  });

  return app;
}
