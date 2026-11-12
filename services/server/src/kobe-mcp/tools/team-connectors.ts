import { z } from "zod";
import {
  cursorSchema,
  kobeTool,
  page,
  type BeforeState,
  type KobeRouteCaller,
} from "../catalog.js";

/**
 * Team console › Connectors (`/v1/team/connectors`, page permission `team.connectors.manage`).
 * The built-in Kobe connector's own level is not offered: it is a safety switch a team admin sets
 * in the console (KA5), never from a conversation.
 */

const exposure = z.enum(["read_only", "all", "custom"]);
const fromExposure = z.enum(["off", "read_only", "all", "custom"]);
type FromExposure = z.infer<typeof fromExposure>;

const connectorRow = z.object({
  id: z.uuid(),
  name: z.string(),
  auth_kind: z.string(),
  credential_source: z.string(),
  status: z.string(),
  enabled: z.boolean(),
  exposure: exposure.nullable(),
  enabled_tools: z.array(z.string()),
  tools: z.array(z.object({ pi_name: z.string(), read_only: z.boolean(), status: z.string() })),
});
const connectorsAnswer = z.object({ connectors: z.array(connectorRow) });

const connectorOut = z.strictObject({
  connector_id: z.uuid(),
  name: z.string().max(200),
  auth_kind: z.string().max(20),
  site_status: z.string().max(20),
  exposure: fromExposure,
  tool_count: z.number().int().nonnegative(),
  read_only_tool_count: z.number().int().nonnegative(),
  /** Custom exposure only: the Pi names of the enabled tools. */
  enabled_tools: z.array(z.string().max(256)).max(200).optional(),
});

export const teamConnectorsList = kobeTool({
  name: "team_connectors_list",
  title: "List team connectors",
  description:
    "Lists the site's registered MCP connectors with this team's exposure: off, read_only, all or " +
    "custom (Team console › Connectors). Paged: pass next_cursor back as cursor.",
  scope: "team",
  permission: "team.connectors.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    connectors: z.array(connectorOut).max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/team/connectors" }),
  reduce: (body, input) => {
    const { rows, next_cursor } = page(connectorsAnswer.parse(body).connectors, input.cursor);
    return {
      connectors: rows.map((c) => ({
        connector_id: c.id,
        name: c.name.slice(0, 200),
        auth_kind: c.auth_kind.slice(0, 20),
        site_status: c.status.slice(0, 20),
        exposure: c.exposure ?? ("off" as const),
        tool_count: c.tools.length,
        read_only_tool_count: c.tools.filter((t) => t.read_only).length,
        ...(c.exposure === "custom" ? { enabled_tools: c.enabled_tools.slice(0, 200) } : {}),
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

/** The team's exposure of the connector as the person reads it; undefined when not registered. */
async function currentExposure(
  call: KobeRouteCaller,
  connectorId: string,
): Promise<FromExposure | undefined | "unreadable"> {
  const answer = await call({ method: "GET", path: "/team/connectors" });
  if (answer.status !== 200) return "unreadable";
  const parsed = connectorsAnswer.safeParse(answer.body);
  if (!parsed.success) return "unreadable";
  const row = parsed.data.connectors.find((c) => c.id === connectorId);
  return row === undefined ? undefined : (row.exposure ?? "off");
}

const NOT_FOUND = { code: "connector_not_found", message: "That connector is not registered." };

const before =
  (input: { connector_id: string; from_exposure: FromExposure }) =>
  async (call: KobeRouteCaller): Promise<BeforeState> => {
    const current = await currentExposure(call, input.connector_id);
    if (current === undefined) return NOT_FOUND;
    return current === input.from_exposure ? "same" : "changed";
  };

const setInput = z
  .strictObject({
    connector_id: z.uuid(),
    /** The team's exposure as the person saw it (team_connectors_list); off: not enabled. */
    from_exposure: fromExposure,
    to_exposure: exposure,
    /** Custom only: the Pi names of the tools to enable (from team_connectors_list). */
    enabled_tools: z.array(z.string().max(256)).max(200).optional(),
  })
  .refine((v) => (v.to_exposure === "custom") === (v.enabled_tools !== undefined), {
    message: "enabled_tools is required for custom exposure and not allowed otherwise",
  });

export const teamConnectorsSetExposure = kobeTool({
  name: "team_connectors_set_exposure",
  title: "Enable a connector or change its exposure",
  description:
    "Enables a registered connector for the conversation's team, or changes which of its tools " +
    "the team's agents may use: read_only (tools marked read-only), all, or custom with " +
    "enabled_tools (Team console › Connectors). Give from_exposure as team_connectors_list shows " +
    "it (off when not enabled). The person is always asked to approve; never retry a refused or " +
    "denied call.",
  scope: "team",
  permission: "team.connectors.manage",
  readOnly: false,
  destructive: false,
  input: setInput,
  output: z.strictObject({ connector_id: z.uuid(), exposure }),
  route: (input) => ({
    method: "PUT",
    path: `/team/connectors/${input.connector_id}`,
    body: {
      exposure: input.to_exposure,
      ...(input.enabled_tools === undefined ? {} : { enabled_tools: input.enabled_tools }),
      expected_exposure: input.from_exposure,
    },
  }),
  reduce: (body) => {
    const { connector } = z.object({ connector: z.object({ id: z.uuid(), exposure }) }).parse(body);
    return { connector_id: connector.id, exposure: connector.exposure };
  },
  before: (input, call) => before(input)(call),
  summary: (input) =>
    `Connector ${input.connector_id}: exposure ${input.from_exposure} → ${input.to_exposure}` +
    (input.enabled_tools === undefined ? "" : ` (${input.enabled_tools.length} tools)`),
});

const disableInput = z.strictObject({
  connector_id: z.uuid(),
  /** The team's exposure as the person saw it (team_connectors_list). */
  from_exposure: exposure,
});

export const teamConnectorsDisable = kobeTool({
  name: "team_connectors_disable",
  title: "Disable a connector for the team",
  description:
    "Turns a connector off for the conversation's team: its tools leave the team's runs " +
    "(Team console › Connectors); it can be enabled again. Give from_exposure as " +
    "team_connectors_list shows it. The person is always asked to approve; never retry a refused " +
    "or denied call.",
  scope: "team",
  permission: "team.connectors.manage",
  readOnly: false,
  destructive: false,
  input: disableInput,
  output: z.strictObject({ connector_id: z.uuid(), exposure: z.literal("off") }),
  route: (input) => ({
    method: "DELETE",
    path: `/team/connectors/${input.connector_id}`,
    query: { expectedExposure: input.from_exposure },
  }),
  reduce: (_body, input) => ({ connector_id: input.connector_id, exposure: "off" as const }),
  before: (input, call) => before(input)(call),
  summary: (input) => `Connector ${input.connector_id}: exposure ${input.from_exposure} → off`,
});
