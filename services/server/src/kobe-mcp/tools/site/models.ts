import { z } from "zod";
import { MODEL_ALIAS_PATTERN } from "@kobe/db";
import { cursorSchema, kobeTool, page } from "../../catalog.js";
import { changeLine, clip, fromTo, missing, readAs, sameValues } from "./shared.js";

/**
 * Site console › Models (`/v1/site/models`, `site.models.manage`) and › Connectors
 * (`/v1/site/connectors`, `site.connectors.manage`) (KOBE-622). Providers and their keys, adding or
 * removing catalog models and registering connectors stay in the console (a key or a probe with
 * the admin's credential is involved).
 */

const MODELS = { method: "GET", path: "/site/models" } as const;
const price = z.number().nullable();
const catalogRow = z.object({
  alias: z.string(),
  provider_id: z.string(),
  model: z.string(),
  label: z.string().nullable(),
  input_modalities: z.array(z.string()),
  max_output_tokens: z.number().int().nullable(),
  context_window: z.number().int().nullable(),
  reasoning: z.boolean(),
  input_usd_per_mtok: price,
  output_usd_per_mtok: price,
});
const modelsAnswer = z.object({
  providers: z.array(
    z.object({ id: z.string(), kind: z.string(), name: z.string(), key_set: z.boolean() }),
  ),
  catalog: z.array(catalogRow),
  gateway: z.object({ in_sync: z.boolean() }),
});

export const siteModelsList = kobeTool({
  name: "site_models_list",
  title: "List models and providers",
  description:
    "Lists the site's model catalog (alias, provider, model id, label, prices in dollars per " +
    "million tokens, output limit and context window) and its providers (never their keys), and " +
    "whether the model gateway has picked up the latest change (Site console › Models). The " +
    "catalog is paged: pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.models.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    catalog: z
      .array(
        z.strictObject({
          alias: z.string().max(64),
          provider_id: z.string().max(64),
          model: z.string().max(200),
          label: z.string().max(200).nullable(),
          images: z.boolean(),
          reasoning: z.boolean(),
          input_usd_per_mtok: price,
          output_usd_per_mtok: price,
          max_output_tokens: z.number().int().nullable(),
          context_window: z.number().int().nullable(),
        }),
      )
      .max(50),
    providers: z
      .array(
        z.strictObject({
          provider_id: z.string().max(64),
          kind: z.string().max(40),
          name: z.string().max(200),
          key_set: z.boolean(),
        }),
      )
      .max(50),
    gateway_in_sync: z.boolean(),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => MODELS,
  reduce: (body, input) => {
    const a = modelsAnswer.parse(body);
    const { rows, next_cursor } = page(a.catalog, input.cursor);
    return {
      catalog: rows.map((m) => ({
        alias: m.alias,
        provider_id: m.provider_id,
        model: clip(m.model, 200),
        label: m.label === null ? null : clip(m.label, 200),
        images: m.input_modalities.includes("image"),
        reasoning: m.reasoning,
        input_usd_per_mtok: m.input_usd_per_mtok,
        output_usd_per_mtok: m.output_usd_per_mtok,
        max_output_tokens: m.max_output_tokens,
        context_window: m.context_window,
      })),
      providers: a.providers.slice(0, 50).map((p) => ({
        provider_id: p.id,
        kind: p.kind,
        name: clip(p.name, 200),
        key_set: p.key_set,
      })),
      gateway_in_sync: a.gateway.in_sync,
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

const catalogChange = fromTo({
  label: z.string().trim().min(1).max(80).nullable(),
  input_usd_per_mtok: z.number().min(0).max(100_000).nullable(),
  output_usd_per_mtok: z.number().min(0).max(100_000).nullable(),
  max_output_tokens: z.number().int().min(1).max(10_000_000).nullable(),
  context_window: z.number().int().min(1).max(100_000_000).nullable(),
});
const catalogInput = z.strictObject({
  alias: z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN)),
  change: catalogChange,
});

export const siteModelsCatalogUpdate = kobeTool({
  name: "site_models_catalog_update",
  title: "Change a catalog model",
  description:
    "Changes a catalog model's label, prices (dollars per million input/output tokens; set both " +
    "or neither) or token limits (null: the site default) (Site console › Models). Give the " +
    "alias and `change: {from, to}`: `to` holds the new values, `from` each one's current value " +
    "from site_models_list. The person is always asked to approve; never retry a refused or " +
    "denied call.",
  scope: "site",
  permission: "site.models.manage",
  readOnly: false,
  destructive: false,
  input: catalogInput,
  output: z.strictObject({
    alias: z.string().max(64),
    label: z.string().max(200).nullable(),
    input_usd_per_mtok: price,
    output_usd_per_mtok: price,
    max_output_tokens: z.number().int().nullable(),
    context_window: z.number().int().nullable(),
  }),
  route: (input) => ({
    method: "PATCH",
    path: `/site/models/catalog/${input.alias}`,
    body: { ...input.change.to, expected: input.change.from },
  }),
  reduce: (body) => {
    const { model: m } = z.object({ model: catalogRow }).parse(body);
    return {
      alias: m.alias,
      label: m.label === null ? null : clip(m.label, 200),
      input_usd_per_mtok: m.input_usd_per_mtok,
      output_usd_per_mtok: m.output_usd_per_mtok,
      max_output_tokens: m.max_output_tokens,
      context_window: m.context_window,
    };
  },
  before: async (input, call) => {
    const a = await readAs(call, MODELS, modelsAnswer);
    const entry = a?.catalog.find((m) => m.alias === input.alias);
    if (a !== undefined && entry === undefined) {
      return missing("model_not_found", "That model is not in the catalog.");
    }
    return entry !== undefined && sameValues(input.change.from, entry) ? "same" : "changed";
  },
  summary: (input) =>
    `Change catalog model ${input.alias}: ${changeLine(input.change.from, input.change.to)}`,
});

const STATUS = z.enum(["active", "disabled"]);
const connectorRow = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  authKind: z.string(),
  credentialSource: z.string(),
  status: STATUS,
  toolCount: z.number().int(),
  driftedCount: z.number().int(),
});

export const siteConnectorsList = kobeTool({
  name: "site_connectors_list",
  title: "List site connectors",
  description:
    "Lists the MCP connectors registered on the site with their URL, authentication kind, " +
    "status (active or disabled), pinned tool count and tools waiting for re-approval (Site " +
    "console › Connectors). Registering a new connector stays in the console. Paged: pass " +
    "next_cursor back as cursor.",
  scope: "site",
  permission: "site.connectors.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    connectors: z
      .array(
        z.strictObject({
          connector_id: z.uuid(),
          name: z.string().max(100),
          url: z.string().max(300),
          auth_kind: z.string().max(20),
          credential_source: z.string().max(20),
          status: STATUS,
          tool_count: z.number().int(),
          drifted_count: z.number().int(),
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/site/connectors" }),
  reduce: (body, input) => {
    const all = z.object({ connectors: z.array(connectorRow) }).parse(body).connectors;
    const { rows, next_cursor } = page(all, input.cursor);
    return {
      connectors: rows.map((c) => ({
        connector_id: c.id,
        name: clip(c.name, 100),
        url: clip(c.url, 300),
        auth_kind: c.authKind,
        credential_source: c.credentialSource,
        status: c.status,
        tool_count: c.toolCount,
        drifted_count: c.driftedCount,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

export const siteConnectorsSetStatus = kobeTool({
  name: "site_connectors_set_status",
  title: "Enable or disable a site connector",
  description:
    "Enables or disables a registered MCP connector for the whole site (Site console › " +
    "Connectors): a disabled connector offers no tools in any team. Give the connector_id, its " +
    "current status (from site_connectors_list) and the new one. The person is always asked to " +
    "approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.connectors.manage",
  readOnly: false,
  destructive: false,
  input: z
    .strictObject({ connector_id: z.uuid(), from_status: STATUS, to_status: STATUS })
    .refine((v) => v.from_status !== v.to_status, { message: "from and to are the same" }),
  output: z.strictObject({ connector_id: z.uuid(), name: z.string().max(100), status: STATUS }),
  route: (input) => ({
    method: "PATCH",
    path: `/site/connectors/${input.connector_id}`,
    body: { status: input.to_status, expectedStatus: input.from_status },
  }),
  reduce: (body) => {
    const { connector } = z.object({ connector: connectorRow }).parse(body);
    return {
      connector_id: connector.id,
      name: clip(connector.name, 100),
      status: connector.status,
    };
  },
  before: async (input, call) => {
    const answer = await call({ method: "GET", path: `/site/connectors/${input.connector_id}` });
    if (answer.status === 404) return missing("connector_not_found", "No such connector.");
    const parsed = z.object({ connector: connectorRow }).safeParse(answer.body);
    if (answer.status !== 200 || !parsed.success) return "changed";
    return parsed.data.connector.status === input.from_status ? "same" : "changed";
  },
  summary: (input) =>
    `${input.to_status === "disabled" ? "Disable" : "Enable"} site connector ${input.connector_id} for every team (${input.from_status} → ${input.to_status})`,
});
