import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index.js";
import {
  SITE_WIDE_COLUMN_GRANTS,
  SITE_WIDE_TABLES,
  TEAM_REFERENCING_SITE_WIDE,
  TEAM_TABLES,
  TENANCY_DOMAINS,
  appPrivilegesFor,
  isTeamTable,
} from "./tenancy.js";

const schemaTables = Object.values(schema)
  .filter((v) => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v)
  .map((t) => getTableConfig(t as Parameters<typeof getTableConfig>[0]));

// The schema uses snake_case casing at the client level, so column keys are camelCase here.
const snake = (name: string): string => name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

describe("tenancy registry", () => {
  it("never lists a table as both team-owned and site-wide", () => {
    const overlap = TEAM_TABLES.filter((t) => (SITE_WIDE_TABLES as readonly string[]).includes(t));
    expect(overlap).toEqual([]);
  });

  it("lists every table once across all spec areas", () => {
    const all = [...TEAM_TABLES, ...SITE_WIDE_TABLES];
    expect(all.filter((t, i) => all.indexOf(t) !== i)).toEqual([]);
  });

  // Areas are merged last-wins; a grant declared by another area could silently widen access.
  it("keeps grants and team-referencing exceptions inside the declaring area", () => {
    for (const domain of TENANCY_DOMAINS) {
      const own = new Set<string>(domain.siteWide);
      const foreign = [
        ...Object.keys(domain.grants),
        ...Object.keys(domain.teamReferencing),
      ].filter((t) => !own.has(t));
      expect(foreign).toEqual([]);
    }
  });

  it("explicitly lists the spec's site-wide tables", () => {
    for (const t of ["users", "teams", "site_roles", "connectors", "audit_log"]) {
      expect(SITE_WIDE_TABLES).toContain(t);
    }
  });

  it("keeps the branding assets site-wide with full privileges and no team_id (KOBE-497)", () => {
    expect(SITE_WIDE_TABLES).toContain("site_branding_assets");
    expect(isTeamTable("site_branding_assets")).toBe(false);
    expect(appPrivilegesFor("site_branding_assets")).toEqual([
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
    ]);
    const table = schemaTables.find((t) => t.name === "site_branding_assets");
    expect(table?.columns.map((c) => snake(c.name))).not.toContain("team_id");
  });

  // KOBE-376 (v1.3 SMA1): semantic memory is split by tenancy, never one mixed table.
  it("splits semantic memory into Workspace team tables and site-wide portable and Site tables", () => {
    for (const t of [
      "semantic_memory_items",
      "semantic_memory_item_versions",
      "run_memory_items",
    ]) {
      expect(isTeamTable(t)).toBe(true);
    }
    const all = ["SELECT", "INSERT", "UPDATE", "DELETE"];
    const siteWide: Record<string, string[]> = {
      portable_memory_items: all,
      portable_memory_item_versions: ["SELECT", "INSERT"],
      site_memory_items: all,
      site_memory_item_versions: ["SELECT", "INSERT"],
    };
    for (const [t, privileges] of Object.entries(siteWide)) {
      expect(SITE_WIDE_TABLES).toContain(t);
      expect(appPrivilegesFor(t)).toEqual(privileges);
      expect(TEAM_REFERENCING_SITE_WIDE).not.toHaveProperty(t);
      const table = schemaTables.find((s) => s.name === t);
      expect(table?.columns.map((c) => snake(c.name))).not.toContain("team_id");
    }
  });

  // KOBE-625 (spec sso-oidc-scim §4–§10): single sign-on and SCIM are site configuration, not
  // team content. Only the access mappings name teams; SCIM tokens are revoked, never deleted.
  it("keeps the SSO and SCIM tables site-wide with least-privilege grants (KOBE-625)", () => {
    const sso = [
      "sso_providers",
      "sso_identities",
      "sso_link_expectations",
      "sso_access_mappings",
      "session_sso_contexts",
      "scim_tokens",
      "scim_groups",
      "scim_group_members",
    ];
    const all = ["SELECT", "INSERT", "UPDATE", "DELETE"];
    for (const t of sso) {
      expect(SITE_WIDE_TABLES).toContain(t);
      expect(isTeamTable(t)).toBe(false);
    }
    for (const t of sso.filter((t) => t !== "scim_tokens")) {
      expect(appPrivilegesFor(t), t).toEqual(all);
    }
    expect(appPrivilegesFor("scim_tokens")).toEqual(["SELECT", "INSERT"]);
    expect(SITE_WIDE_COLUMN_GRANTS.scim_tokens).toEqual({
      UPDATE: ["last_used_at", "revoked_at"],
    });
    expect(Object.keys(TEAM_REFERENCING_SITE_WIDE).filter((t) => sso.includes(t))).toEqual([
      "sso_access_mappings",
    ]);
    for (const t of sso.filter((t) => t !== "sso_access_mappings")) {
      const table = schemaTables.find((s) => s.name === t);
      expect(table, t).toBeDefined();
      expect(table?.columns.map((c) => snake(c.name))).not.toContain("team_id");
    }
  });

  it("classifies every table defined in the Drizzle schema", () => {
    const unclassified = schemaTables
      .map((t) => t.name)
      .filter(
        (name) => !isTeamTable(name) && !(SITE_WIDE_TABLES as readonly string[]).includes(name),
      );
    expect(unclassified).toEqual([]);
  });

  it("gives every team table a NOT NULL uuid team_id", () => {
    for (const table of schemaTables.filter((t) => isTeamTable(t.name))) {
      const teamId = table.columns.find((c) => snake(c.name) === "team_id");
      expect(teamId, `${table.name}.team_id`).toBeDefined();
      expect(teamId?.notNull, `${table.name}.team_id NOT NULL`).toBe(true);
      expect(teamId?.getSQLType(), `${table.name}.team_id type`).toBe("uuid");
    }
  });
});
