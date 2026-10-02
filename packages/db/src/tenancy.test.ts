import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index.js";
import { INSTALL_WIDE_TABLES, TEAM_TABLES, TENANCY_DOMAINS, isTeamTable } from "./tenancy.js";

const schemaTables = Object.values(schema)
  .filter((v) => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v)
  .map((t) => getTableConfig(t as Parameters<typeof getTableConfig>[0]));

// The schema uses snake_case casing at the client level, so column keys are camelCase here.
const snake = (name: string): string => name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

describe("tenancy registry", () => {
  it("never lists a table as both team-owned and install-wide", () => {
    const overlap = TEAM_TABLES.filter((t) =>
      (INSTALL_WIDE_TABLES as readonly string[]).includes(t),
    );
    expect(overlap).toEqual([]);
  });

  it("lists every table once across all spec areas", () => {
    const all = [...TEAM_TABLES, ...INSTALL_WIDE_TABLES];
    expect(all.filter((t, i) => all.indexOf(t) !== i)).toEqual([]);
  });

  // Areas are merged last-wins; a grant declared by another area could silently widen access.
  it("keeps grants and team-referencing exceptions inside the declaring area", () => {
    for (const domain of TENANCY_DOMAINS) {
      const own = new Set<string>(domain.installWide);
      const foreign = [
        ...Object.keys(domain.grants),
        ...Object.keys(domain.teamReferencing),
      ].filter((t) => !own.has(t));
      expect(foreign).toEqual([]);
    }
  });

  it("explicitly lists the spec's install-wide tables", () => {
    for (const t of ["users", "teams", "install_roles", "connectors", "audit_log"]) {
      expect(INSTALL_WIDE_TABLES).toContain(t);
    }
  });

  it("classifies every table defined in the Drizzle schema", () => {
    const unclassified = schemaTables
      .map((t) => t.name)
      .filter(
        (name) => !isTeamTable(name) && !(INSTALL_WIDE_TABLES as readonly string[]).includes(name),
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
