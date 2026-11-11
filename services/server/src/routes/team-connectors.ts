import { Hono } from "hono";
import { z } from "zod";
import { KOBE_MCP_TEAM_LEVELS, withTeam } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  disableTeamConnector,
  listTeamConnectors,
  setTeamConnector,
} from "../connectors/team-store.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { readKobeTeamConnector, setKobeTeamLevel } from "../kobe-mcp/switches.js";

const exposureSchema = z.enum(["read_only", "all", "custom"]);

const bodySchema = z
  .strictObject({
    exposure: exposureSchema,
    /** Pi tool names; custom exposure only. */
    enabled_tools: z.array(z.string().max(256)).max(1000).optional(),
    /**
     * KOBE-621: the team's exposure as the caller saw it (`off`: not enabled); another one is a 409
     * `changed_since_approval` (a Kobe MCP write's approved before-state).
     */
    expected_exposure: z.enum(["off", "read_only", "all", "custom"]).optional(),
  })
  .refine((b) => (b.exposure === "custom") === (b.enabled_tools !== undefined), {
    message: "enabled_tools is required for custom exposure and not allowed otherwise",
  });

const kobeLevelSchema = z.strictObject({
  level: z.enum(KOBE_MCP_TEAM_LEVELS),
  /** The level as the caller saw it; another one is a 409 `changed_since_approval`. */
  expected_level: z.enum(KOBE_MCP_TEAM_LEVELS).optional(),
});

const MESSAGES = {
  not_found: [404, "connector_not_found", "That connector is not registered."],
  connector_disabled: [409, "connector_disabled", "The site admin has disabled that connector."],
  unknown_tool: [422, "unknown_tool", "Pick only tools the connector lists (not drifted ones)."],
  changed_since_approval: [
    409,
    "changed_since_approval",
    "The team's exposure changed meanwhile; nothing was changed.",
  ],
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

  /**
   * The built-in Kobe connector (KOBE-623, spec kobe-admin-mcp §6, KA5): the site switch and the
   * team's level (`docs` default, `read`, `read_write`). Registered before `/:id`.
   */
  app.get("/kobe", requireTeamPermission("team.read"), async (c) => {
    const teamId = c.get("team").id;
    return c.json({ kobe: await withTeam(db, teamId, (tx) => readKobeTeamConnector(tx, teamId)) });
  });

  app.put("/kobe", requireTeamPermission("team.connectors.manage"), async (c) => {
    const body = await parseBody(c, kobeLevelSchema);
    if (!body) {
      return invalidRequest(c, 'Send {"level": "docs" | "read" | "read_write"}.');
    }
    const teamId = c.get("team").id;
    const set = await setKobeTeamLevel(db, teamId, body.level, body.expected_level);
    if (!set.ok) {
      return c.json(
        { code: "changed_since_approval", message: "The team's Kobe level changed meanwhile." },
        409,
      );
    }
    return c.json({ kobe: await withTeam(db, teamId, (tx) => readKobeTeamConnector(tx, teamId)) });
  });

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
      {
        exposure: body.exposure,
        enabledTools: body.enabled_tools ?? [],
        expectedExposure: body.expected_exposure,
      },
      c.get("user").id,
    );
    if (result.ok) return c.json({ connector: result.connector });
    const [status, code, message] = MESSAGES[result.error];
    return c.json({ code, message }, status);
  });

  app.delete("/:id", requireTeamPermission("team.connectors.manage"), async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json(notFound(), 404);
    // `?expectedExposure=` (KOBE-621): disable only while the exposure is still this one.
    const expectedRaw = c.req.query("expectedExposure");
    const expected = expectedRaw === undefined ? undefined : exposureSchema.safeParse(expectedRaw);
    if (expected !== undefined && !expected.success) return invalidRequest(c);
    const removed = await disableTeamConnector(db, c.get("team").id, id.data, expected?.data);
    if (removed === "changed_since_approval") {
      const [status, code, message] = MESSAGES.changed_since_approval;
      return c.json({ code, message }, status);
    }
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
