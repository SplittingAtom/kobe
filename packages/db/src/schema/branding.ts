import { sql } from "drizzle-orm";
import { check, customType, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

// Site branding files (KOBE-497, theming plan TH7): the logo, the optional dark logo and the
// favicon, stored in Postgres (backups take them with every other `public` table; the sign-in page
// needs no object store). Site-wide (†) like `site_settings`, which holds the name and the theme
// (`branding.app_name`, `branding.theme`): one organisation, one brand (TH1), so no team_id and no
// team RLS; the server lets only `site.settings.manage` write. The limits mirror
// `BRANDING_ASSET_MAX_BYTES` and `BRANDING_ASSET_MAX_SIDE_PX` in `@kobe/protocol` (the server
// checks them first; these checks are the backstop).

const KIB = 1024;
const LOGO_MAX_BYTES = 512 * KIB;
const FAVICON_MAX_BYTES = 256 * KIB;
const MAX_SIDE_PX = 4096;
/** Mirrors `BRANDING_ASSET_CONTENT_TYPES` in `@kobe/protocol` (TH8; ICO only as a favicon). */
const sqlList = (types: readonly string[]) => types.map((t) => `'${t}'`).join(", ");
const LOGO_TYPES = sqlList(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const FAVICON_TYPES = sqlList(["image/png", "image/svg+xml", "image/x-icon"]);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Site-wide (†): one branding file per kind. `sha256` (hex) names the bytes: asset URLs carry it
 * (`?v=`) and the audit event records it, never the bytes. `width`/`height` are null for SVG and
 * ICO. Removing a file deletes its row.
 */
export const siteBrandingAssets = pgTable(
  "site_branding_assets",
  {
    kind: text().primaryKey(),
    bytes: bytea().notNull(),
    contentType: text().notNull(),
    sha256: text().notNull(),
    byteSize: integer().notNull(),
    width: integer(),
    height: integer(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Users are deactivated, never deleted (NO ACTION).
    updatedBy: uuid().references(() => users.id),
  },
  (t) => [
    check("site_branding_assets_kind", sql`${t.kind} IN ('logo', 'logo_dark', 'favicon')`),
    check("site_branding_assets_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "site_branding_assets_size",
      sql`${t.byteSize} = octet_length(${t.bytes}) AND ${t.byteSize} > 0 AND ${t.byteSize} <= CASE WHEN ${t.kind} = 'favicon' THEN ${sql.raw(String(FAVICON_MAX_BYTES))} ELSE ${sql.raw(String(LOGO_MAX_BYTES))} END`,
    ),
    check(
      "site_branding_assets_dimensions",
      sql`(${t.width} IS NULL OR ${t.width} BETWEEN 1 AND ${sql.raw(String(MAX_SIDE_PX))}) AND (${t.height} IS NULL OR ${t.height} BETWEEN 1 AND ${sql.raw(String(MAX_SIDE_PX))})`,
    ),
    check(
      "site_branding_assets_content_type",
      sql`CASE WHEN ${t.kind} = 'favicon' THEN ${t.contentType} IN (${sql.raw(FAVICON_TYPES)}) ELSE ${t.contentType} IN (${sql.raw(LOGO_TYPES)}) END`,
    ),
  ],
);
