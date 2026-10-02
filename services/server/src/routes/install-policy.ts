import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { parseRuleBody, ruleIdParam, ruleLimitReached, ruleNotFound } from "../policy/http.js";
import {
  createInstallRule,
  deleteInstallRule,
  listInstallRules,
  readPromptSandboxWrites,
  updateInstallRule,
  writePromptSandboxWrites,
} from "../policy/rule-store.js";
import {
  installRuleBodySchema,
  SCOPE_LIMITS,
  policySettingsBodySchema,
} from "../policy/schemas.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/**
 * The install policy floor (`/v1/install/policy`, spec D6, D8, D29): deny and ask rules that bind
 * every team, and the install's policy switches. Install Owner/Admins only.
 */
export function installPolicyRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.policy.manage"));

  app.get("/rules", async (c) => c.json({ rules: await listInstallRules(db) }));

  app.post("/rules", async (c) => {
    const body = await parseRuleBody(c, installRuleBodySchema);
    if (!body.ok) return body.response;
    const result = await createInstallRule(db, body.value, c.get("user").id, SCOPE_LIMITS);
    if (!result.ok) return ruleLimitReached(c);
    return c.json({ rule: result.rule }, 201);
  });

  app.put("/rules/:id", async (c) => {
    const id = ruleIdParam(c);
    const body = await parseRuleBody(c, installRuleBodySchema);
    if (!body.ok) return body.response;
    if (id === undefined) return invalidRequest(c);
    const result = await updateInstallRule(db, id, body.value, SCOPE_LIMITS);
    if (result.ok) return c.json({ rule: result.rule });
    return result.error === "not_found" ? ruleNotFound(c) : ruleLimitReached(c);
  });

  app.delete("/rules/:id", async (c) => {
    const id = ruleIdParam(c);
    if (id === undefined) return invalidRequest(c);
    return (await deleteInstallRule(db, id)) ? c.body(null, 204) : ruleNotFound(c);
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
