import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import {
  createConnector,
  createSchema,
  getConnector,
  listConnectors,
  removeConnector,
  updateConnector,
  updateSchema,
  type NameConflict,
} from "../connectors/registry.js";
import { checkConnectorUrl } from "../connectors/url-policy.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const idSchema = z.uuid();

const notFound = (c: Context) =>
  c.json({ code: "not_found", message: "That connector is not registered." }, 404);

const CONFLICTS: Record<NameConflict, string> = {
  name_taken:
    "A connector with that name is already registered (names that differ only in - and _ count as the same).",
  name_removed:
    "A removed connector that teams still referenced keeps that name (names that differ only in - and _ count as the same). Pick another name.",
};
const nameConflict = (c: Context, error: NameConflict) =>
  c.json({ code: error, message: CONFLICTS[error] }, 409);

const invalidFields =
  "Check the fields: name is lowercase letters and digits joined by - or _ (up to 64), url and iconUrl are https URLs, authKind is none, api_key or oauth.";

/**
 * The install connector registry (`/v1/install/connectors`, spec D6, D27; KOBE-100): install
 * Owner/Admins register MCP servers. URLs must pass the address policy the MCP proxy enforces at
 * connect time. Every change is audited without the URL (it may carry a key).
 */
export function installConnectorsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.connectors.manage"));

  const badUrl = (c: Context, check: { code: string; message: string }) =>
    c.json({ code: check.code, message: check.message }, 422);

  app.get("/", async (c) => c.json({ connectors: await listConnectors(db) }));

  app.get("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const found = id.success ? await getConnector(db, id.data) : undefined;
    return found ? c.json({ connector: found }) : notFound(c);
  });

  app.post("/", async (c) => {
    const input = await parseBody(c, createSchema);
    if (!input) return invalidRequest(c, invalidFields);
    const checked = await checkConnectorUrl(input.url, deps.connectorUrlPolicy);
    if (!checked.ok) return badUrl(c, checked);
    const result = await createConnector(db, { ...input, url: checked.url }, c.get("user").id);
    return result.ok ? c.json({ connector: result.connector }, 201) : nameConflict(c, result.error);
  });

  app.patch("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const input = await parseBody(c, updateSchema);
    if (!input) return invalidRequest(c, invalidFields);
    let patch = input;
    if (input.url !== undefined) {
      const checked = await checkConnectorUrl(input.url, deps.connectorUrlPolicy);
      if (!checked.ok) return badUrl(c, checked);
      patch = { ...input, url: checked.url };
    }
    const result = await updateConnector(db, id.data, patch);
    if (result.ok) return c.json({ connector: result.connector });
    return result.error === "not_found" ? notFound(c) : nameConflict(c, result.error);
  });

  app.delete("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const result = id.success ? await removeConnector(db, id.data) : undefined;
    if (!result) return notFound(c);
    const message =
      result.teams > 0
        ? `Removed from the registry. ${result.teams} team${result.teams === 1 ? "" : "s"} had it enabled, so it is kept disabled: it is offered to no team and its calls are refused.`
        : "Removed from the registry. It is kept disabled and its name stays reserved.";
    return c.json({ ...result, message });
  });

  return app;
}
