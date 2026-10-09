import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  disableTeamConnector,
  listTeamConnectors,
  setTeamConnector,
} from "../connectors/team-store.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const bodySchema = z
  .strictObject({
    exposure: z.enum(["read_only", "all", "custom"]),
    /** Pi tool names; custom exposure only. */
    enabled_tools: z.array(z.string().max(256)).max(1000).optional(),
  })
  .refine((b) => (b.exposure === "custom") === (b.enabled_tools !== undefined), {
    message: "enabled_tools is required for custom exposure and not allowed otherwise",
  });

const MESSAGES = {
  not_found: [404, "connector_not_found", "That connector is not registered."],
  connector_disabled: [409, "connector_disabled", "The install admin has disabled that connector."],
  unknown_tool: [422, "unknown_tool", "Pick only tools the connector lists (not drifted ones)."],
} as const;

/**
 * Team connectors (`/v1/team/connectors`, spec D27, KOBE-104). Members see the registered
 * connectors and what the team enabled; team admins enable one with an exposure, or disable it.
 * Off by default. Enforcement at the MCP proxy is KOBE-106.
 */
export function teamConnectorsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) =>
    c.json({ connectors: await listTeamConnectors(db, c.get("team").id) }),
  );

  app.put("/:id", requireTeamPermission("team.connectors.manage"), async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json(notFound(), 404);
    const body = await parseBody(c, bodySchema);
    if (!body) {
      return invalidRequest(
        c,
        'Send {"exposure": "read_only" | "all"} or {"exposure": "custom", "enabled_tools": [...]}.',
      );
    }
    const result = await setTeamConnector(
      db,
      c.get("team").id,
      id.data,
      { exposure: body.exposure, enabledTools: body.enabled_tools ?? [] },
      c.get("user").id,
    );
    if (result.ok) return c.json({ connector: result.connector });
    const [status, code, message] = MESSAGES[result.error];
    return c.json({ code, message }, status);
  });

  app.delete("/:id", requireTeamPermission("team.connectors.manage"), async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json(notFound(), 404);
    const removed = await disableTeamConnector(db, c.get("team").id, id.data);
    return removed
      ? c.body(null, 204)
      : c.json({ code: "not_enabled", message: "The team has not enabled that connector." }, 404);
  });

  return app;
}

function notFound() {
  const [, code, message] = MESSAGES.not_found;
  return { code, message };
}
