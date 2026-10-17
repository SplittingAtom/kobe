import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { parseRuleBody, ruleIdParam, ruleLimitReached, ruleNotFound } from "../policy/http.js";
import { rememberLimitsSchema } from "@kobe/protocol";
import {
  readTeamRememberLimits,
  writeTeamRememberLimits,
} from "../policy/remember-limits-store.js";
import {
  createTeamRule,
  deleteTeamRule,
  listTeamRules,
  updateTeamRule,
} from "../policy/rule-store.js";
import { SCOPE_LIMITS, teamRuleBodySchema } from "../policy/schemas.js";
import {
  deleteMemberRule,
  deleteUserRule,
  listMemberRules,
  listUserRules,
} from "../policy/user-rules.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/**
 * Team tool policy (`/v1/team/policy`, spec D6, D8, D29). Every member can read the team's rules
 * (they explain policy reasons on tool cards); only team admins change them. Members list and
 * revoke their own remember-rules here; creating one goes through an approval (KOBE-37).
 *
 * KOBE-289: team admins also list and revoke every member's remembered approvals in this team
 * (`/member-rules`, under the team's RLS: never another team's), and set the team's remember
 * limits (`/remember-limits`), which can only tighten the site floor's. Every member can read the
 * limits (the card offers only what they allow).
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
    const result = await createTeamRule(db, team, body.value, c.get("user").id, SCOPE_LIMITS);
    if (!result.ok) return ruleLimitReached(c);
    return c.json({ rule: result.rule }, 201);
  });

  app.put("/rules/:id", requireTeamPermission("team.policy.manage"), async (c) => {
    const id = ruleIdParam(c);
    const body = await parseRuleBody(c, teamRuleBodySchema);
    if (!body.ok) return body.response;
    if (id === undefined) return invalidRequest(c);
    const result = await updateTeamRule(db, c.get("team").id, id, body.value, SCOPE_LIMITS);
    if (result.ok) return c.json({ rule: result.rule });
    return result.error === "not_found" ? ruleNotFound(c) : ruleLimitReached(c);
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

  app.get("/member-rules", requireTeamPermission("team.policy.manage"), async (c) =>
    c.json({ rules: await listMemberRules(db, c.get("team").id) }),
  );

  app.delete("/member-rules/:id", requireTeamPermission("team.policy.manage"), async (c) => {
    const id = ruleIdParam(c);
    if (id === undefined) return invalidRequest(c);
    const removed = await deleteMemberRule(db, c.get("team").id, id);
    return removed ? c.body(null, 204) : ruleNotFound(c);
  });

  app.get("/remember-limits", requireTeamPermission("team.read"), async (c) =>
    c.json(await readTeamRememberLimits(db, c.get("team").id)),
  );

  app.put("/remember-limits", requireTeamPermission("team.policy.manage"), async (c) => {
    const body = await parseBody(c, rememberLimitsSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Send scopes, max_duration_seconds, mcp_tools, exact_only and approve_all.",
      );
    }
    const result = await writeTeamRememberLimits(db, c.get("team").id, body);
    if (!result.ok) {
      return c.json(
        {
          code: "limits_above_floor",
          message: `The site floor is stricter: ${result.looser.join(", ")}. A team can only tighten it.`,
          fields: result.looser,
        },
        400,
      );
    }
    return c.json(result.limits);
  });

  return app;
}
