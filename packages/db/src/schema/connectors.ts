import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PinnedTool } from "../connectors/snapshot.js";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// MCP connectors (spec D6, D27, §5.4). Site admins register remote (Streamable HTTP) servers
// and Kobe pins each tool (`connectors`, site-wide); team admins enable a connector for their
// team with an exposure (`team_connectors`, a team table). The MCP proxy (KOBE-58) lists and calls
// only pinned tools of connectors enabled in the caller's team. This is the minimal model the proxy
// core needs; KOBE-59 (registry, pinning, drift), KOBE-60 (enablement UI) and KOBE-61 (grants) add
// their columns and tables.

/** `none`: no credential; `oauth` / `api_key`: the user's own grant (KOBE-61). */
export const connectorAuthKind = pgEnum("connector_auth_kind", ["oauth", "api_key", "none"]);
export type ConnectorAuthKind = (typeof connectorAuthKind.enumValues)[number];

/**
 * Whose credential an `api_key` connector uses (KOBE-303): `member`, each member's own key (D27);
 * `site`, one site-wide key a site admin sets (`connector_site_keys`), never both.
 */
export const CONNECTOR_CREDENTIAL_SOURCES = ["member", "site"] as const;
export type ConnectorCredentialSource = (typeof CONNECTOR_CREDENTIAL_SOURCES)[number];

/** `disabled`: kept registered, but offered to no team (calls are refused). */
export const connectorStatus = pgEnum("connector_status", ["active", "disabled"]);
export type ConnectorStatus = (typeof connectorStatus.enumValues)[number];

/** D27 exposure: `read_only` = tools with `readOnlyHint: true`; `custom` = `enabled_tools`. */
export const connectorExposure = pgEnum("connector_exposure", ["read_only", "all", "custom"]);
export type ConnectorExposureKind = (typeof connectorExposure.enumValues)[number];

/**
 * Same grammar as `connectorNameSchema` in @kobe/protocol: lowercase `[a-z0-9]` runs joined by a
 * single `-` or `_` (so Pi's `mcp__<server>__<tool>` names split unambiguously), at most 64.
 */
export const CONNECTOR_NAME_PATTERN = "^[a-z0-9]+([-_][a-z0-9]+)*$";

/** Longest connector URL / icon URL the registry stores. */
export const CONNECTOR_URL_MAX = 2048;

/**
 * Built-in connectors hosted by Kobe itself (KOBE-618, spec kobe-admin-mcp §3): `kobe`, the Kobe
 * MCP server (docs and admin tools). Its row is seeded by the server at start
 * ({@link seedKobeBuiltinConnector}); the MCP proxy routes it to the server's internal listener,
 * never to its URL, which only marks the row (a check ties the two together, so no registered
 * connector can carry the internal URL and no built-in can point anywhere else).
 */
export const BUILTIN_CONNECTORS = ["kobe"] as const;
export type BuiltinConnector = (typeof BUILTIN_CONNECTORS)[number];

/**
 * The `kobe` row's fixed id, the same on every site ("kobe" in hex, then a v4-shaped tail), so
 * replicas seed one row and the MCP proxy can route it without asking.
 */
export const KOBE_BUILTIN_CONNECTOR_ID = "6b6f6265-0000-4000-8000-000000000001";

/** The `kobe` row's URL: a marker in the reserved `.internal` zone, never fetched. */
export const KOBE_BUILTIN_CONNECTOR_URL = "http://kobe-server.internal/internal/v1/mcp/kobe";

/**
 * Site switch of the Kobe MCP server (`site_settings`, spec §6, KA5): `off` (no `kobe` connector),
 * `docs` (docs tools only; the default, also when unset or unreadable), `admin` (docs plus the
 * admin tools each team turns on).
 */
export const KOBE_MCP_MODE_KEY = "kobe_mcp.mode";
export const KOBE_MCP_MODES = ["off", "docs", "admin"] as const;
export type KobeMcpMode = (typeof KOBE_MCP_MODES)[number];
export const KOBE_MCP_MODE_DEFAULT: KobeMcpMode = "docs";

/**
 * Team switch (`teams.settings`, spec §6, KA5): `docs` (default), `read` (admin reads), or
 * `read_write` (admin reads and writes). Only honoured while the site switch is `admin`.
 */
export const KOBE_MCP_TEAM_SETTING = "kobe_mcp.admin";
export const KOBE_MCP_TEAM_LEVELS = ["docs", "read", "read_write"] as const;
export type KobeMcpTeamLevel = (typeof KOBE_MCP_TEAM_LEVELS)[number];
export const KOBE_MCP_TEAM_LEVEL_DEFAULT: KobeMcpTeamLevel = "docs";

/** The site switch from its stored text: anything but a known mode is the default. */
export function parseKobeMcpMode(value: string | null | undefined): KobeMcpMode {
  return (KOBE_MCP_MODES as readonly string[]).includes(value ?? "")
    ? (value as KobeMcpMode)
    : KOBE_MCP_MODE_DEFAULT;
}

/** The team switch from `teams.settings`: anything but a known level is the default. */
export function parseKobeMcpTeamLevel(settings: unknown): KobeMcpTeamLevel {
  const value =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)[KOBE_MCP_TEAM_SETTING]
      : undefined;
  return typeof value === "string" && (KOBE_MCP_TEAM_LEVELS as readonly string[]).includes(value)
    ? (value as KobeMcpTeamLevel)
    : KOBE_MCP_TEAM_LEVEL_DEFAULT;
}

/** Site-wide (†): the connector registry (site admins, D6). */
export const connectors = pgTable(
  "connectors",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Pi server name (`mcp__<name>__<tool>`); unique, also after `-` → `_` (Pi treats them alike). */
    name: text().notNull(),
    /** Streamable HTTP endpoint (D27: remote only, no stdio). */
    url: text().notNull(),
    authKind: connectorAuthKind().notNull().default("none"),
    /** KOBE-303: `site` only for `api_key` connectors; then members never use their own keys. */
    credentialSource: text().$type<ConnectorCredentialSource>().notNull().default("member"),
    status: connectorStatus().notNull().default("active"),
    /** Optional https icon URL (KOBE-100); the admin UI renders it as an image. */
    iconUrl: text(),
    /** The site admin who registered it (KOBE-100); null for rows older than that. */
    createdBy: uuid().references(() => users.id),
    /**
     * Soft delete (KOBE-100): a removed connector that teams still reference stays as a disabled
     * row (their `team_connectors` rows are kept for the later wiring) and leaves the registry list.
     */
    deletedAt: timestamp({ withTimezone: true }),
    /** Pinned `tools/list` snapshot: an array of {@link PinnedTool} (validated on read). */
    toolsSnapshot: jsonb().$type<PinnedTool[]>().notNull().default([]),
    /** SHA-256 over the whole snapshot (KOBE-59 drift detection), when pinned. */
    toolsHash: text(),
    /**
     * The site admin who last pinned or re-approved the tools (KOBE-431): the periodic refresh of a
     * connector that needs a credential probes with this admin's own key, never a member's.
     */
    pinnedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Why the last periodic refresh was skipped (a probe failure code); null after a good one. */
    refreshSkipped: text(),
    /** When the periodic refresh last probed the connector (skipped or not). */
    refreshedAt: timestamp({ withTimezone: true }),
    /**
     * How its tools were pinned (KOBE-433): 1, before tools pinned their MCP Apps template
     * reference (`ui`); 2, since. Only a version-1 snapshot adopts a `ui` reference silently, once,
     * on its first refresh; afterwards a tool that starts naming a template drifts.
     */
    pinVersion: integer().notNull().default(1),
    /**
     * Why the last refresh did not check the MCP Apps templates (KOBE-433 review NEW-2), while the
     * tools were checked; null after a pass that checked them. Shown to site admins.
     */
    templatesSkipped: text(),
    /**
     * Built-in connector hosted by Kobe (KOBE-618): `kobe`, or NULL for a registered remote server.
     * A built-in row has no credential, no pinned snapshot, and is skipped by the probe, pinning,
     * the periodic refresh and drift: its tools come from Kobe's own catalog.
     */
    builtin: text().$type<BuiltinConnector>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("connectors_name_key").on(t.name),
    // Pi counts names that differ only in `-` / `_` as the same server.
    uniqueIndex("connectors_server_segment_key").on(sql`replace(${t.name}, '-', '_')`),
    check(
      "connectors_name",
      sql`char_length(${t.name}) <= 64 AND ${t.name} ~ '${sql.raw(CONNECTOR_NAME_PATTERN)}'`,
    ),
    check(
      "connectors_url",
      sql`char_length(${t.url}) <= 2048 AND ${t.url} ~ '^https?://[^[:space:]]+$'`,
    ),
    check(
      "connectors_icon_url",
      sql`${t.iconUrl} IS NULL OR (char_length(${t.iconUrl}) <= 2048 AND ${t.iconUrl} ~ '^https://[^[:space:]]+$')`,
    ),
    check("connectors_tools_snapshot", sql`jsonb_typeof(${t.toolsSnapshot}) = 'array'`),
    check(
      "connectors_tools_hash",
      sql`${t.toolsHash} IS NULL OR ${t.toolsHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("connectors_credential_source", sql`${t.credentialSource} IN ('member', 'site')`),
    check(
      "connectors_site_key_api_key",
      sql`${t.credentialSource} = 'member' OR ${t.authKind} = 'api_key'`,
    ),
    check("connectors_pin_version", sql`${t.pinVersion} IN (1, 2)`),
    check(
      "connectors_templates_skipped",
      sql`${t.templatesSkipped} IS NULL OR ${t.templatesSkipped} ~ '^[a-z_]{1,32}$'`,
    ),
    uniqueIndex("connectors_builtin_key")
      .on(t.builtin)
      .where(sql`${t.builtin} IS NOT NULL`),
    check(
      "connectors_builtin",
      sql`${t.builtin} IS NULL OR (${t.builtin} = 'kobe' AND ${t.id} = '${sql.raw(KOBE_BUILTIN_CONNECTOR_ID)}'::uuid AND ${t.authKind} = 'none' AND ${t.credentialSource} = 'member' AND ${t.toolsHash} IS NULL AND ${t.toolsSnapshot} = '[]'::jsonb)`,
    ),
    // Only the built-in carries the internal URL, and the built-in carries nothing else.
    check(
      "connectors_builtin_url",
      sql`(${t.builtin} IS NOT NULL) = (${t.url} = '${sql.raw(KOBE_BUILTIN_CONNECTOR_URL)}')`,
    ),
    check(
      "connectors_refresh_skipped",
      sql`${t.refreshSkipped} IS NULL OR ${t.refreshSkipped} ~ '^[a-z_]{1,32}$'`,
    ),
  ],
);

/**
 * Team table: connectors a team enabled (D27: off by default, so no row = not enabled) and their
 * exposure. `enabled_tools` (Pi tool names) applies to `custom` exposure only.
 */
export const teamConnectors = pgTable(
  "team_connectors",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    exposure: connectorExposure().notNull().default("read_only"),
    enabledTools: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    enabledBy: uuid()
      .notNull()
      .references(() => users.id),
    enabledAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.connectorId] }),
    check("team_connectors_enabled_tools", sql`cardinality(${t.enabledTools}) <= 1000`),
  ],
);
