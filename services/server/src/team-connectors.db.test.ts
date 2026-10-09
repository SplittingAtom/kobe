import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { loadTeamConnector, exposedTools } from "./mcp/catalog.js";
import { loadTeamFacts } from "./runs/resolver-input.js";
import { openHarness, type Harness } from "./testing/harness.js";
import type { TestBrowser } from "./testing/browser.js";
import { registerConnector } from "./testing/mcp-fixtures.js";

/**
 * Team connector enablement (KOBE-104, D27): off by default; team admins enable an install
 * connector with an exposure (read_only, all, custom tick list); audited; run offering follows.
 */
const BASE = "/v1/team/connectors";
const teamA = randomUUID();
const teamB = randomUUID();
let h: Harness;
let admin: TestBrowser;
let member: TestBrowser;
let other: TestBrowser;
let adminId = "";
let jira: Awaited<ReturnType<typeof registerConnector>>;

function requireConnector<T>(c: T | undefined): T {
  if (c === undefined) throw new Error("connector not enabled");
  return c;
}

const piNames = (c: typeof jira, ...tools: string[]) =>
  c.tools.filter((t) => tools.includes(t.name)).map((t) => t.pi_name);

beforeAll(async () => {
  h = await openHarness();
  adminId = await h.createUser("ta@tc.test");
  const memberId = await h.createUser("tm@tc.test");
  const otherId = await h.createUser("tb@tc.test");
  for (const [id, slug] of [
    [teamA, "alpha"],
    [teamB, "beta"],
  ] as const) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
  for (const [t, u, role] of [
    [teamA, adminId, "team_admin"],
    [teamA, memberId, "member"],
    [teamB, otherId, "team_admin"],
  ] as const) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      t,
      u,
      role,
    ]);
  }
  admin = await h.signIn("ta@tc.test");
  member = await h.signIn("tm@tc.test");
  other = await h.signIn("tb@tc.test");
  admin.team = teamA;
  member.team = teamA;
  other.team = teamB;
  for (const [b, t] of [
    [admin, teamA],
    [member, teamA],
    [other, teamB],
  ] as const) {
    expect((await b.put("/v1/me/teams/active", { teamId: t })).status).toBe(200);
  }
  jira = await registerConnector(h.admin, { name: "jira" });
});
afterAll(async () => {
  await h?.close();
});

const state = async (b: TestBrowser) =>
  (await b.get(BASE)).json.connectors.find((c: { id: string }) => c.id === jira.id);

describe("off by default", () => {
  it("lists registered connectors as not enabled and offers no tools", async () => {
    const res = await admin.get(BASE);
    expect(res.status).toBe(200);
    expect(await state(admin)).toMatchObject({ name: "jira", enabled: false, exposure: null });
    expect(await state(member)).toMatchObject({ enabled: false });
    const facts = await withTeam(h.deps.database.db, teamA, (tx) => loadTeamFacts(tx, teamA));
    expect(facts.connectors).toEqual([]);
    expect(await loadTeamConnector(h.deps.database.db, teamA, jira.id)).toBeUndefined();
  });
});

describe("access", () => {
  it("lets members read but only team admins change", async () => {
    expect((await member.get(BASE)).status).toBe(200);
    expect((await member.put(`${BASE}/${jira.id}`, { exposure: "all" })).status).toBe(403);
    expect((await member.delete(`${BASE}/${jira.id}`)).status).toBe(403);
    expect((await h.browser().get(BASE)).status).toBe(401);
    expect(await state(admin)).toMatchObject({ enabled: false });
  });

  it("hides connectors that are removed or unknown", async () => {
    expect((await admin.put(`${BASE}/${randomUUID()}`, { exposure: "all" })).status).toBe(404);
    expect((await admin.put(`${BASE}/not-a-uuid`, { exposure: "all" })).status).toBe(404);
  });
});

describe("enable and exposure", () => {
  it("enables with read_only: only readOnlyHint tools are offered", async () => {
    const res = await admin.put(`${BASE}/${jira.id}`, { exposure: "read_only" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.connector).toMatchObject({ enabled: true, exposure: "read_only" });
    const c = await loadTeamConnector(h.deps.database.db, teamA, jira.id);
    expect(exposedTools(requireConnector(c)).map((t) => t.name)).toEqual(["get_issue"]);
    const facts = await withTeam(h.deps.database.db, teamA, (tx) => loadTeamFacts(tx, teamA));
    expect(facts.connectors.map((x) => x.id)).toEqual([jira.id]);
  });

  it("is per team", async () => {
    const res = await other.get(BASE);
    expect(res.json.connectors.find((c: { id: string }) => c.id === jira.id).enabled).toBe(false);
  });

  it("custom stores the tick list; drifted and unknown tools are refused", async () => {
    const picked = piNames(jira, "get_issue", "delete_issue");
    const res = await admin.put(`${BASE}/${jira.id}`, {
      exposure: "custom",
      enabled_tools: [...picked, picked[0]],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.connector.enabled_tools.toSorted()).toEqual(picked.toSorted());
    const c = await loadTeamConnector(h.deps.database.db, teamA, jira.id);
    expect(
      exposedTools(requireConnector(c))
        .map((t) => t.name)
        .toSorted(),
    ).toEqual(["delete_issue", "get_issue"]);

    for (const bad of [piNames(jira, "rename_issue"), ["mcp__jira__nope"]]) {
      const r = await admin.put(`${BASE}/${jira.id}`, { exposure: "custom", enabled_tools: bad });
      expect(r.status).toBe(422);
      expect(r.json.code).toBe("unknown_tool");
    }
  });

  it("rejects malformed bodies", async () => {
    for (const body of [
      {},
      { exposure: "everything" },
      { exposure: "all", enabled_tools: piNames(jira, "get_issue") },
      { exposure: "custom" },
      { exposure: "all", extra: 1 },
    ]) {
      expect((await admin.put(`${BASE}/${jira.id}`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await state(admin)).toMatchObject({ exposure: "custom" });
  });

  it("switching away from custom clears the list", async () => {
    const res = await admin.put(`${BASE}/${jira.id}`, { exposure: "all" });
    expect(res.json.connector).toMatchObject({ exposure: "all", enabled_tools: [] });
  });

  it("refuses to enable a disabled connector", async () => {
    const off = await registerConnector(h.admin, { name: "off", status: "disabled" });
    const res = await admin.put(`${BASE}/${off.id}`, { exposure: "all" });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("connector_disabled");
  });

  it("a connector disabled or removed by the install stops being offered", async () => {
    await h.admin.query(`UPDATE connectors SET status = 'disabled' WHERE id = $1`, [jira.id]);
    const facts = await withTeam(h.deps.database.db, teamA, (tx) => loadTeamFacts(tx, teamA));
    expect(facts.connectors).toEqual([]);
    expect((await state(admin)).status).toBe("disabled");
    await h.admin.query(`UPDATE connectors SET status = 'active' WHERE id = $1`, [jira.id]);
  });
});

describe("disable", () => {
  it("removes the enablement and offers nothing again", async () => {
    expect((await admin.delete(`${BASE}/${jira.id}`)).status).toBe(204);
    expect(await state(admin)).toMatchObject({ enabled: false });
    expect(await loadTeamConnector(h.deps.database.db, teamA, jira.id)).toBeUndefined();
    expect((await admin.delete(`${BASE}/${jira.id}`)).status).toBe(404);
  });
});

describe("audit", () => {
  it("records each change with the exposure and the custom list, nothing when unchanged", async () => {
    const { rows } = await h.admin.query(
      `SELECT action, team_id, target FROM audit_log WHERE action = 'mcp.connector.team_changed' ORDER BY seq`,
    );
    expect(rows.map((r) => r.target.change)).toEqual([
      "enabled",
      "exposure_changed",
      "exposure_changed",
      "disabled",
    ]);
    expect(rows.every((r) => r.team_id === teamA)).toBe(true);
    expect(rows[0].target).toMatchObject({ name: "jira", exposure: "read_only", tools: [] });
    expect(rows[1].target.tools).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toMatch(/https?:/);

    await admin.put(`${BASE}/${jira.id}`, { exposure: "all" });
    await admin.put(`${BASE}/${jira.id}`, { exposure: "all" });
    const after = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'mcp.connector.team_changed'`,
    );
    expect(after.rows[0].n).toBe(5);
  });
});
