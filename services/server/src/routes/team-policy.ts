import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { parseRuleBody, ruleIdParam, ruleLimitReached, ruleNotFound } from "../policy/http.js";
import {
  createTeamRule,
  deleteTeamRule,
  deleteUserRule,
  listTeamRules,
  listUserRules,
  updateTeamRule,
} from "../policy/rule-store.js";
import { MAX_RULES_PER_SCOPE, teamRuleBodySchema } from "../policy/schemas.js";
import { invalidRequest } from "../teams/http.js";

/**
 * Team tool policy (`/v1/team/policy`, spec D6, D8, D29). Every member can read the team's rules
 * (they explain policy reasons on tool cards); only team admins change them. Members list and
 * revoke their own remember-rules here; creating one goes through an approval (KOBE-37).
 */
export function teamPolicyRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/rules", requireTeamPermission("team.read"), async (c) =>
    c.json({ rules: await listTeamRules(db, c.get("team").id) }),
  );

  app.post("/rules", requireTeamPermission("team.policy.manage"), async (c) => {
    const body = await parseRuleBody(c, teamRuleBodySchema);
    if (!body.ok) return body.response;
    const team = c.get("team").id;
    const result = await createTeamRule(
      db,
      team,
      body.value,
      c.get("user").id,
      MAX_RULES_PER_SCOPE,
    );
    if (!result.ok) return ruleLimitReached(c);
    return c.json({ rule: result.rule }, 201);
  });

  app.put("/rules/:id", requireTeamPermission("team.policy.manage"), async (c) => {
    const id = ruleIdParam(c);
    const body = await parseRuleBody(c, teamRuleBodySchema);
    if (!body.ok) return body.response;
    if (id === undefined) return invalidRequest(c);
    const rule = await updateTeamRule(db, c.get("team").id, id, body.value);
    return rule ? c.json({ rule }) : ruleNotFound(c);
  });

  app.delete("/rules/:id", requireTeamPermission("team.policy.manage"), async (c) => {
    const id = ruleIdParam(c);
    if (id === undefined) return invalidRequest(c);
    return (await deleteTeamRule(db, c.get("team").id, id)) ? c.body(null, 204) : ruleNotFound(c);
  });

  app.get("/my-rules", requireTeamPermission("team.read"), async (c) =>
    c.json({ rules: await listUserRules(db, c.get("team").id, c.get("user").id) }),
  );

  app.delete("/my-rules/:id", requireTeamPermission("team.read"), async (c) => {
    const id = ruleIdParam(c);
    if (id === undefined) return invalidRequest(c);
    const removed = await deleteUserRule(db, c.get("team").id, c.get("user").id, id);
    return removed ? c.body(null, 204) : ruleNotFound(c);
  });

  return app;
}
