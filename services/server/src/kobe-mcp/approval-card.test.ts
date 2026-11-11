import { describe, expect, it } from "vitest";
import { kobeAdminApprovalCard, resolveNames, withNames } from "./approval-card.js";

const ANA = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const CONN = "33333333-3333-4333-8333-333333333333";

/** A reader answering `name` by the id bound into the statement (one lookup per id). */
function fakeDb(names: Record<string, string>) {
  const seen: string[] = [];
  const statements: string[] = [];
  return {
    seen,
    // The reader only needs `execute`; the statement is matched by the id it binds.
    execute: async (query: unknown) => {
      const params = JSON.stringify(query);
      statements.push(params);
      const id = Object.keys(names).find((k) => params.includes(k));
      seen.push(id ?? "?");
      return { rows: id === undefined ? [] : [{ name: names[id] }] } as never;
    },
    statements,
  } as unknown as Parameters<typeof resolveNames>[0] & { seen: string[]; statements: string[] };
}

describe("Kobe admin approval card (KOBE-623)", () => {
  it("builds the team card with the person's and the team's names", async () => {
    const db = fakeDb({ [ANA]: "Ana Lee", [TEAM]: "Research" });
    const card = await kobeAdminApprovalCard(db, TEAM, "mcp__kobe__team_members_set_role", {
      user_id: ANA,
      from_role: "member",
      to_role: "team_admin",
    });
    expect(card).toEqual({
      scope: "team",
      scope_label: "Team Research",
      summary: 'Change the role of member "Ana Lee" (11111111…): Member → Team admin',
    });
  });

  it("works under the fallback connector name and keeps an id it cannot name", async () => {
    const db = fakeDb({ [TEAM]: "Research" });
    const card = await kobeAdminApprovalCard(
      db,
      TEAM,
      "mcp__kobe_builtin__team_connectors_disable",
      { connector_id: CONN, from_exposure: "all" },
    );
    expect(card?.summary).toBe(`Connector ${CONN}: exposure all → off`);
  });

  it("gives no card for reads, docs tools and unknown tools", async () => {
    const db = fakeDb({});
    for (const tool of [
      "mcp__kobe__team_members_list",
      "mcp__kobe__docs_index",
      "mcp__kobe__team_ownership_transfer",
      "bash",
    ]) {
      expect(await kobeAdminApprovalCard(db, TEAM, tool, {})).toBeUndefined();
    }
    expect(db.seen).toEqual([]);
  });

  it("names the tool only when the input does not fit its schema", async () => {
    const db = fakeDb({ [TEAM]: "Research" });
    const card = await kobeAdminApprovalCard(db, TEAM, "mcp__kobe__team_members_set_role", {
      user_id: ANA,
      to_role: "owner",
    });
    expect(card?.summary).toMatch(/\(input not valid\)$/);
  });

  it("only looks up known id keys holding UUIDs", async () => {
    const db = fakeDb({ [ANA]: "Ana Lee" });
    const names = await resolveNames(
      db,
      { user_id: ANA, email: ANA, team_id: "not-an-id" },
      { scope: "site", teamId: TEAM },
    );
    expect([...names]).toEqual([[ANA, '"Ana Lee" (11111111…)']]);
    expect(db.seen).toEqual([ANA]);
  });

  it("names a person only as a member of the team for a team tool, a team only for a site tool", async () => {
    const db = fakeDb({ [ANA]: "Ana Lee" });
    await resolveNames(db, { user_id: ANA, team_id: TEAM }, { scope: "team", teamId: TEAM });
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]).toContain("team_members");
    const site = fakeDb({ [ANA]: "Ana Lee", [TEAM]: "Research" });
    const names = await resolveNames(
      site,
      { user_id: ANA, team_id: TEAM },
      { scope: "site", teamId: TEAM },
    );
    expect(names.get(TEAM)).toBe('"Research" (22222222…)');
    expect(site.statements[0]).not.toContain("team_members");
  });

  it("quotes a crafted name so it cannot pass for the change itself", async () => {
    const db = fakeDb({ [ANA]: 'x" to Owner; also "Bob\nsays' });
    const names = await resolveNames(db, { user_id: ANA }, { scope: "team", teamId: TEAM });
    expect(names.get(ANA)).toBe(`"x' to Owner; also 'Bob says" (11111111…)`);
  });

  it("keeps the summary one bounded line", () => {
    const out = withNames(`a\n${ANA}\tb`, new Map([[ANA, "x".repeat(2000)]]));
    expect(out).not.toMatch(/[\n\t]/);
    expect(out.length).toBe(1000);
  });
});
