import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProposedUiResource, UiResourceMeta } from "../connectors/ui-resources.js";
import { users } from "./auth.js";
import { connectors } from "./connectors.js";

/** MCP Apps (KOBE-433, spec mcp-apps-host §5, MA9): the only template type Kobe pins. */
export const UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
/** Largest template Kobe pins (MA9): 512 KiB of UTF-8. */
export const UI_RESOURCE_MAX_BYTES = 512 * 1024;
/** Longest `ui://` URI Kobe pins. */
export const UI_RESOURCE_URI_MAX = 2048;
/** Largest declared `_meta.ui` Kobe stores (serialized JSON). */
export const UI_RESOURCE_META_MAX_BYTES = 16 * 1024;

/** `drifted`: changed or new upstream; never rendered until a site admin approves (D27, MA-2). */
export const UI_RESOURCE_STATUSES = ["pinned", "drifted"] as const;
export type UiResourceStatus = (typeof UI_RESOURCE_STATUSES)[number];

/**
 * Where an app opens (KOBE-531, spec MA3 as amended 2026-10-31), set by a site admin per template:
 * `chat` the card in the conversation (default), `artifacts` the card's stub with the frame in the
 * artifact column, `rail` also offered in the rail's Pickers. Not part of the pin hash.
 */
export const UI_RESOURCE_PLACEMENTS = ["chat", "artifacts", "rail"] as const;
export type UiResourcePlacement = (typeof UI_RESOURCE_PLACEMENTS)[number];

/**
 * Site-wide (†): the pinned `ui://` templates of a connector's tools (MCP Apps, KOBE-433). The
 * server's pin and refresh probes read them through mcp-proxy (never the sandbox) and Kobe hashes
 * the bytes itself. Like `connectors.tools_snapshot`, a drifted row keeps the approved bytes and
 * carries the live ones in `proposed`; a new row is `drifted` with the live bytes and no
 * `proposed`. No team data; deleting the connector deletes its templates.
 */
export const connectorUiResources = pgTable(
  "connector_ui_resources",
  {
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    /** The `ui://` URI the tools' `_meta.ui.resourceUri` names. */
    uri: text().notNull(),
    mimeType: text().notNull(),
    /** The approved template (UTF-8 HTML); served only while `status` is `pinned`. */
    html: text().notNull(),
    /** SHA-256 (hex) of `html`'s UTF-8 bytes, computed by Kobe. */
    sha256: text().notNull(),
    /** The declared `_meta.ui` (csp, permissions, domain, prefersBorder) of the approved bytes. */
    meta: jsonb().$type<UiResourceMeta>().notNull().default({}),
    /** SHA-256 of the canonical `{uri, mimeType, sha256, ui}`: the pin drift compares. */
    pinnedHash: text().notNull(),
    status: text().$type<UiResourceStatus>().notNull().default("pinned"),
    /**
     * On a drifted row: the live template awaiting review, or why the live one cannot be pinned
     * (`{invalid}`). An unapproved row that was invalid from the start holds an empty placeholder
     * in `html` and its reason here.
     */
    proposed: jsonb().$type<ProposedUiResource>(),
    /**
     * Whether a site admin ever approved this row's `html` (first pin or review). A row the
     * refresh found (new upstream) is not, and can never be `pinned` until it is (CHECK).
     */
    approved: boolean().notNull().default(false),
    /** The site admin who pinned or approved it; null for refresh-added (new) rows. */
    pinnedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Where the app opens (KOBE-531); a site admin's choice, outside `pinnedHash`. */
    placement: text().$type<UiResourcePlacement>().notNull().default("chat"),
    pinnedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectorId, t.uri] }),
    check(
      "connector_ui_resources_uri",
      sql`char_length(${t.uri}) <= ${sql.raw(String(UI_RESOURCE_URI_MAX))} AND ${t.uri} ~ '^ui://[!-~]+$'`,
    ),
    // `chr(59)` is the `;`: drizzle-kit splits generated statements on a literal one.
    check(
      "connector_ui_resources_mime_type",
      sql`${t.mimeType} = 'text/html' || chr(59) || 'profile=mcp-app'`,
    ),
    check(
      "connector_ui_resources_html",
      sql`octet_length(${t.html}) <= ${sql.raw(String(UI_RESOURCE_MAX_BYTES))}`,
    ),
    check("connector_ui_resources_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("connector_ui_resources_pinned_hash", sql`${t.pinnedHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "connector_ui_resources_meta",
      sql`jsonb_typeof(${t.meta}) = 'object' AND octet_length(${t.meta}::text) <= ${sql.raw(String(UI_RESOURCE_META_MAX_BYTES))}`,
    ),
    check("connector_ui_resources_placement", sql`${t.placement} IN ('chat', 'artifacts', 'rail')`),
    check("connector_ui_resources_status", sql`${t.status} IN ('pinned', 'drifted')`),
    // Nothing a site admin never approved can be served.
    check("connector_ui_resources_approved", sql`${t.approved} OR ${t.status} = 'drifted'`),
    check(
      "connector_ui_resources_proposed",
      sql`${t.proposed} IS NULL OR (${t.status} = 'drifted' AND jsonb_typeof(${t.proposed}) = 'object')`,
    ),
  ],
);
