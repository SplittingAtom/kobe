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
import {
  approveConnectorTools,
  approveSchema,
  reviewConnectorTools,
} from "../connectors/reapproval.js";
import { pinConnector, type PinOutcome } from "../connectors/pinning.js";
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

const PIN_MESSAGES: Record<Extract<PinOutcome, { ok: false }>["failure"], string> = {
  url_not_allowed: "The address is not allowed by this install's connector policy.",
  forbidden_address: "The server resolves to an address Kobe may not reach.",
  unreachable: "The server could not be reached.",
  timeout: "The server did not answer in time.",
  auth_required:
    "The server asked for credentials, which a pinning probe does not have. Tools stay unpinned (none are offered).",
  http_error: "The server answered with an error.",
  protocol_error: "The server did not answer as an MCP server.",
  too_large: "The server's tool list was too large.",
  rpc_error: "The server refused the tools/list request.",
  proxy_unavailable: "Kobe's MCP proxy could not be reached, so nothing was probed.",
  invalid_tool: "The server listed a tool Kobe cannot pin (invalid name, description or schema).",
  ambiguous_tool_names:
    "The server lists tools whose names collide once - . and _ are treated alike, so none was pinned.",
  already_pinned: "This connector already has pinned tools; changing them needs re-approval.",
  changed: "The connector changed while it was being probed. Probe it again.",
};

/** The `pin` part of a response: what happened to the tool surface (never the server's own text). */
const pinBody = (pin: PinOutcome) =>
  pin.ok
    ? { ok: true as const, tools: pin.tools }
    : { ok: false as const, failure: pin.failure, message: PIN_MESSAGES[pin.failure] };

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
    if (!result.ok) return nameConflict(c, result.error);
    // Registering snapshots and pins every tool; a failed probe leaves it registered, unpinned.
    const pin = await pinConnector(db, deps.connectorProbe, result.connector.id);
    const connector = (await getConnector(db, result.connector.id)) ?? result.connector;
    return c.json({ connector, ...(pin ? { pin: pinBody(pin) } : {}) }, 201);
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
    if (!result.ok)
      return result.error === "not_found" ? notFound(c) : nameConflict(c, result.error);
    // A new URL cleared the old pins; pin the new server's tools (no-op when pins still exist).
    const pin =
      patch.url === undefined ? undefined : await pinConnector(db, deps.connectorProbe, id.data);
    const connector = (await getConnector(db, id.data)) ?? result.connector;
    const shown =
      pin && !(!pin.ok && pin.failure === "already_pinned") ? { pin: pinBody(pin) } : {};
    return c.json({ connector, ...shown });
  });

  // Probe and pin again, for a connector that has none (the registration probe failed).
  app.post("/:id/pin", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const pin = id.success ? await pinConnector(db, deps.connectorProbe, id.data) : undefined;
    if (!id.success || !pin) return notFound(c);
    const connector = await getConnector(db, id.data);
    return c.json(
      { connector, pin: pinBody(pin) },
      pin.ok || pin.failure === "already_pinned" ? 200 : 502,
    );
  });

  // What each tool is now: approved vs live definition, for the re-approval review (KOBE-102).
  app.get("/:id/tools", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const tools = id.success ? await reviewConnectorTools(db, id.data) : undefined;
    return tools ? c.json({ tools }) : notFound(c);
  });

  // Re-approve drifted tools, each with the hash of the live definition that was reviewed.
  app.post("/:id/tools/approve", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const input = await parseBody(c, approveSchema);
    if (!input) {
      return invalidRequest(c, "Send tools: a list of { name, sha256 } of the reviewed tools.");
    }
    const result = await approveConnectorTools(db, id.data, input);
    if (result.ok) return c.json({ approved: result.approved });
    if (result.error === "not_found") return notFound(c);
    return c.json(
      result.error === "stale"
        ? {
            code: "stale",
            tool: result.tool,
            message: "That tool changed again since you reviewed it. Review it again.",
          }
        : {
            code: "not_pending",
            tool: result.tool,
            message: "That tool is not waiting for approval.",
          },
      409,
    );
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
