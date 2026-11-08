import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeAgentFile } from "@kobe/agent-file";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * Agent rosters (KOBE-566, spec agents-roster AR6, AR7, AR16, §5, §6.3-6.5, §6.8, §6.9): the
 * roster read, assign/propose, decide, withdraw, pin/update, remove, suspend/resume, the §5 matrix
 * per role, caps, rate limit, delete while rostered, audit. Own throwaway database.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";
const ANY = { "if-match": "*" };

type Person = "sam" | "alice" | "bob" | "carol" | "dave";
// Finance: alice team_admin, bob builder, carol member, sam member (and site admin).
// Marketing: dave builder.
const PEOPLE: readonly Person[] = ["sam", "alice", "bob", "carol", "dave"];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();
const marketing = randomUUID();

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;

async function sql<T extends pg.QueryResultRow>(text: string, args: unknown[] = []) {
  const admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  try {
    return (await admin.query<T>(text, args)).rows;
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "t".repeat(48),
    setupToken: "setup-token-for-roster-tests-012",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const user = await deps.createUserWithPassword(
      { email: `${who}@roster.test`, name: who, password: PASSWORD },
      who === "sam" ? { siteRole: "admin" } : {},
    );
    ids[who] = user.id;
  }
  await sql(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance'), ($2, 'marketing', 'Marketing')`,
    [finance, marketing],
  );
  const members: [string, Person, string][] = [
    [finance, "alice", "team_admin"],
    [finance, "bob", "builder"],
    [finance, "carol", "member"],
    [finance, "sam", "member"],
    [marketing, "dave", "builder"],
  ];
  for (const [team, who, role] of members) {
    await sql(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
  }
  for (const who of PEOPLE) {
    const b = new TestBrowser(app, PUBLIC_URL);
    const res = await b.post("/api/auth/sign-in/email", {
      email: `${who}@roster.test`,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    as[who] = b;
    const team = who === "dave" ? marketing : finance;
    const active = await b.put("/v1/me/teams/active", { teamId: team });
    expect(active.status, JSON.stringify(active.json)).toBe(200);
    b.team = team;
  }
});

afterAll(async () => {
  await deps?.close();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

async function personal(who: Person, name: string, publish = true): Promise<string> {
  const created = await as[who].post("/v1/agents", {
    scope: "personal",
    frontmatter: { name, description: `${name} helps` },
    prompt: `You are ${name}.`,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  if (publish) await publishAgent(who, id);
  return id;
}

async function publishAgent(who: Person, id: string): Promise<void> {
  const pub = await as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
}

async function edit(who: Person, id: string, name: string): Promise<void> {
  const res = await as[who].request(
    "PUT",
    `/v1/agents/${id}`,
    { frontmatter: { name }, prompt: `You are ${name}.` },
    ANY,
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

const assign = (who: Person, id: string, target: "team" | "site", versionRule?: unknown) =>
  as[who].post(`/v1/agents/${id}/assignments`, {
    target,
    ...(versionRule === undefined ? {} : { versionRule }),
  });
const teamPut = (who: Person, id: string, body: object) =>
  as[who].put(`/v1/team/agent-roster/${id}`, body);
const sitePut = (who: Person, id: string, body: object) =>
  as[who].put(`/v1/site/agent-roster/${id}`, body);
const withdraw = (who: Person, id: string, target: "team" | "site") =>
  as[who].request("DELETE", `/v1/agents/${id}/assignments/${target}`);

type Row = {
  agentId: string;
  kind: string;
  name: string;
  status: string;
  versionInEffect: number | null;
  updateAvailable: boolean;
  entry: {
    state: string;
    note: string | null;
    versionRule: string;
    pinnedVersion: number | null;
  } | null;
  reach?: { target: string; teamName: string | null; state: string; note: string | null }[];
  actions: Record<string, unknown>;
};
async function roster(who: Person, tab: string, query = ""): Promise<Row[]> {
  const res = await as[who].get(`/v1/agents/roster?tab=${tab}${query}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.rows as Row[];
}
const rowOf = (rows: Row[], id: string) => rows.find((r) => r.agentId === id);

async function audited(action: string, agentId: string) {
  return sql<{ team_id: string | null; target: Record<string, unknown> }>(
    `SELECT team_id, target FROM audit_log WHERE action = $1 AND target->>'agentId' = $2 ORDER BY seq`,
    [action, agentId],
  );
}

describe("assigning and proposing (AR6, ac-1, ac-2)", () => {
  it("a builder assigns their own agent to the team directly (201), audited with the team", async () => {
    const agent = await personal("bob", "Bob Ledger");
    const res = await assign("bob", agent, "team");
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.entry).toMatchObject({
      agentId: agent,
      target: "team",
      teamId: finance,
      state: "active",
      versionRule: "latest",
      assignedBy: ids.bob,
    });
    const rows = await audited("agent.roster.assigned", agent);
    expect(rows).toEqual([
      {
        team_id: finance,
        target: {
          agentId: agent,
          scope: "personal",
          slug: "bob-ledger",
          roster: "team",
          versionRule: "latest",
          pinnedVersion: null,
        },
      },
    ]);
    // Everyone in the team sees it on the Team tab; a member gets no admin actions.
    const carolRow = rowOf(await roster("carol", "team"), agent);
    expect(carolRow).toMatchObject({ kind: "personal", status: "active", versionInEffect: 1 });
    expect(carolRow?.actions).toMatchObject({ viewDefinition: false, remove: false, pin: false });
    expect(rowOf(await roster("alice", "team"), agent)?.actions).toMatchObject({
      remove: true,
      pin: true,
      suspendHere: true,
    });
    // Marketing never sees Finance's roster.
    expect(rowOf(await roster("dave", "team"), agent)).toBeUndefined();
    // A second assignment is refused.
    expect((await assign("bob", agent, "team")).status).toBe(409);
  });

  it("a member proposes (202); proposals show to the proposer and team admins only", async () => {
    const agent = await personal("carol", "Carol Notes");
    const res = await assign("carol", agent, "team");
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    expect(res.json.entry.state).toBe("proposed");
    expect(rowOf(await roster("carol", "team"), agent)?.status).toBe("proposed");
    expect(rowOf(await roster("bob", "team"), agent)).toBeUndefined();
    expect(rowOf(await roster("alice", "team"), agent)?.actions).toMatchObject({ decide: true });
    const reach = rowOf(await roster("carol", "personal"), agent)?.reach;
    expect(reach).toEqual([
      { target: "team", teamId: finance, teamName: "Finance", state: "proposed", note: null },
    ]);
    expect((await audited("agent.roster.proposed", agent)).length).toBe(1);
  });

  it("team admins approve or decline (with a note); the proposer may withdraw", async () => {
    const approveMe = await personal("carol", "Carol Approve");
    const declineMe = await personal("carol", "Carol Decline");
    const withdrawMe = await personal("carol", "Carol Withdraw");
    for (const id of [approveMe, declineMe, withdrawMe]) {
      expect((await assign("carol", id, "team")).status).toBe(202);
    }
    // Builders and members can't decide; team admins can.
    expect((await teamPut("bob", approveMe, { state: "active" })).status).toBe(403);
    expect((await teamPut("carol", approveMe, { state: "active" })).status).toBe(403);
    const approved = await teamPut("alice", approveMe, { state: "active" });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    expect(approved.json.entry).toMatchObject({ state: "active", decidedBy: ids.alice });
    expect((await audited("agent.roster.approved", approveMe))[0]?.team_id).toBe(finance);

    const declined = await teamPut("alice", declineMe, {
      state: "removed",
      note: "Overlaps Ledger",
    });
    expect(declined.json.entry).toMatchObject({ state: "removed", note: "Overlaps Ledger" });
    const reach = rowOf(await roster("carol", "personal"), declineMe)?.reach;
    expect(reach?.[0]).toMatchObject({ state: "removed", note: "Overlaps Ledger" });
    // The note never reaches the audit log.
    expect((await audited("agent.roster.declined", declineMe))[0]?.target).not.toHaveProperty(
      "note",
    );
    // A declined entry can't be approved later; the owner re-proposes instead (AR7).
    expect((await teamPut("alice", declineMe, { state: "active" })).json.code).toBe(
      "roster_entry_not_found",
    );
    expect((await teamPut("alice", declineMe, { state: "active", versionRule: 1 })).status).toBe(
      409,
    );
    expect((await assign("carol", declineMe, "team")).status).toBe(202);

    const out = await withdraw("carol", withdrawMe, "team");
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    expect(out.json.entry.state).toBe("removed");
    expect((await withdraw("carol", withdrawMe, "team")).status).toBe(404);
    // Only the owner withdraws.
    expect((await withdraw("alice", approveMe, "team")).status).toBe(404);
    expect((await audited("agent.roster.withdrawn", withdrawMe)).length).toBe(1);
  });

  it("site: site admins assign directly; others propose published agents only (AR6)", async () => {
    const draft = await personal("bob", "Bob Draft", false);
    expect((await assign("bob", draft, "site")).status).toBe(422);
    const bobs = await personal("bob", "Bob Site");
    const proposed = await assign("bob", bobs, "site");
    expect(proposed.status, JSON.stringify(proposed.json)).toBe(202);
    expect(proposed.json.entry).toMatchObject({ target: "site", teamId: null, state: "proposed" });
    // Site admins decide; team roles don't count on the site roster.
    expect((await sitePut("alice", bobs, { state: "active" })).status).toBe(403);
    expect((await sitePut("bob", bobs, { state: "active" })).status).toBe(403);
    expect((await sitePut("carol", bobs, { state: "active" })).status).toBe(403);
    const approved = await sitePut("sam", bobs, { state: "active" });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    expect((await audited("agent.roster.approved", bobs))[0]?.team_id).toBeNull();
    // A site admin assigns their own draft directly.
    const samDraft = await personal("sam", "Sam Draft", false);
    expect((await assign("sam", samDraft, "site")).status).toBe(201);
    // Everyone sees the site entry, in any team; drafts as not published.
    expect(rowOf(await roster("dave", "site"), bobs)).toMatchObject({ status: "active" });
    expect(rowOf(await roster("dave", "site"), samDraft)).toMatchObject({
      status: "not_published",
      name: "sam-draft",
    });
    // A builder of another team puts the site-assigned agent on their roster by reference (§5).
    const ref = await assign("dave", bobs, "team");
    expect(ref.status, JSON.stringify(ref.json)).toBe(201);
    expect(ref.json.entry).toMatchObject({ teamId: marketing, assignedBy: ids.dave });
    // Someone else's personal agent that isn't on the site roster doesn't exist for the caller.
    const hidden = await personal("carol", "Carol Hidden");
    expect((await assign("dave", hidden, "team")).status).toBe(404);
  });
});

describe("version rules (AR5)", () => {
  it("pins an entry, shows Update available, and updates back to latest", async () => {
    const agent = await personal("bob", "Bob Pinned");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    await edit("bob", agent, "Bob Pinned Two");
    await publishAgent("bob", agent);
    const pinned = await teamPut("alice", agent, { state: "active", versionRule: 1 });
    expect(pinned.status, JSON.stringify(pinned.json)).toBe(200);
    expect(pinned.json.entry).toMatchObject({ versionRule: "pinned", pinnedVersion: 1 });
    const row = rowOf(await roster("carol", "team"), agent);
    // Members see the version in effect, never the owner's newer draft or version.
    expect(row).toMatchObject({ versionInEffect: 1, updateAvailable: true, name: "Bob Pinned" });
    expect((await teamPut("alice", agent, { state: "active", versionRule: 9 })).status).toBe(404);
    const latest = await teamPut("alice", agent, { state: "active", versionRule: "latest" });
    expect(latest.json.entry).toMatchObject({ versionRule: "latest", pinnedVersion: null });
    expect((await audited("agent.roster.pinned", agent))[0]?.target).toMatchObject({
      pinnedVersion: 1,
    });
    expect((await audited("agent.roster.updated", agent))[0]?.target).toMatchObject({
      versionRule: "latest",
    });
    // The owner can't change the team's pin.
    expect((await teamPut("bob", agent, { state: "active", versionRule: 1 })).status).toBe(403);
  });
});

describe("removal and suspension (AR7, §6.5)", () => {
  it("team admins suspend and resume an entry for the team (team_agent_suspensions only), then remove it", async () => {
    const agent = await personal("bob", "Bob Suspend");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    expect((await teamPut("bob", agent, { state: "suspended" })).status).toBe(403);
    const suspended = await teamPut("alice", agent, { state: "suspended" });
    expect(suspended.json).toEqual({ agentId: agent, suspendedHere: true });
    // The entry stays active: the team's suspension row is the one record (§6.5).
    expect(
      await sql(`SELECT state FROM team_agent_roster WHERE site_agent_id = $1`, [agent]),
    ).toEqual([{ state: "active" }]);
    expect(
      await sql(`SELECT 1 FROM team_agent_suspensions WHERE team_id = $1 AND agent_id = $2`, [
        finance,
        agent,
      ]),
    ).toHaveLength(1);
    expect(rowOf(await roster("alice", "team"), agent)).toMatchObject({
      status: "suspended_here",
      actions: expect.objectContaining({ suspendHere: false, resumeHere: true }),
    });
    // The inventory's resume clears the same fact.
    expect(
      (await as.alice.put(`/v1/agents/inventory/${agent}/status`, { status: "active" })).status,
    ).toBe(404); // not used by a thread yet: the inventory doesn't list it
    const resumed = await teamPut("alice", agent, { state: "active" });
    expect(resumed.json).toEqual({ agentId: agent, suspendedHere: false });
    expect(
      await sql(`SELECT 1 FROM team_agent_suspensions WHERE agent_id = $1`, [agent]),
    ).toHaveLength(0);
    const removed = await teamPut("alice", agent, { state: "removed" });
    expect(removed.json.entry).toMatchObject({ state: "removed" });
    expect(rowOf(await roster("alice", "team"), agent)).toBeUndefined();
    for (const action of ["suspended", "resumed", "removed"]) {
      expect((await audited(`agent.roster.${action}`, agent))[0]?.team_id).toBe(finance);
    }
    // A removed entry is re-assigned by its owner (AR7).
    expect((await assign("bob", agent, "team")).status).toBe(201);
  });

  it("team admins suspend a gallery agent for the team; site admins suspend a site entry site-wide", async () => {
    const [seeded] = await seedGalleryAgents(deps.database.db, [
      {
        key: "roster-gallery",
        generation: 1,
        file: serializeAgentFile({ frontmatter: { name: "Gallery Pal" }, prompt: "Hi." }),
      },
    ]);
    const gallery = seeded?.agentId ?? "";
    expect((await teamPut("bob", gallery, { state: "suspended" })).status).toBe(403);
    const here = await teamPut("alice", gallery, { state: "suspended" });
    expect(here.status, JSON.stringify(here.json)).toBe(200);
    expect(here.json).toEqual({ agentId: gallery, suspendedHere: true });
    expect(rowOf(await roster("carol", "site"), gallery)?.status).toBe("suspended_here");
    expect(rowOf(await roster("dave", "site"), gallery)?.status).toBe("active");
    expect((await teamPut("alice", gallery, { state: "active" })).json.suspendedHere).toBe(false);

    const agent = await personal("carol", "Carol Wide");
    expect((await assign("sam", agent, "site")).status).toBe(404);
    expect((await assign("carol", agent, "site")).status).toBe(202);
    expect((await sitePut("sam", agent, { state: "active" })).status).toBe(200);
    const wide = await sitePut("sam", agent, { state: "suspended" });
    expect(wide.json.entry.state).toBe("suspended");
    expect(rowOf(await roster("dave", "site"), agent)?.status).toBe("suspended_site");
    expect(rowOf(await roster("sam", "site"), agent)?.actions).toMatchObject({
      resumeSiteWide: true,
      suspendSiteWide: false,
    });
    expect((await audited("agent.roster.suspended", agent))[0]?.team_id).toBeNull();
    expect((await sitePut("sam", agent, { state: "removed" })).json.entry.state).toBe("removed");
    // Unknown on the site roster.
    expect((await sitePut("sam", randomUUID(), { state: "active" })).status).toBe(404);
  });
});

describe("review fixes", () => {
  it("a site admin without a team admin role can't decide team entries (403)", async () => {
    const agent = await personal("carol", "Carol For Sam");
    expect((await assign("carol", agent, "team")).status).toBe(202);
    const res = await teamPut("sam", agent, { state: "active" });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("forbidden");
  });

  it("a builder assigning or proposing a bound agent of another team gets 422", async () => {
    const agent = await personal("bob", "Bob Bound Elsewhere");
    await sql(`UPDATE site_agents SET bound_team_id = $1 WHERE id = $2`, [marketing, agent]);
    expect((await assign("bob", agent, "team")).json.code).toBe("agent_bound_to_team");
    expect((await assign("bob", agent, "site")).json.code).toBe("agent_bound_to_team");
  });

  it("only roster admins pin on assign (422 version_rule_not_allowed)", async () => {
    const bobs = await personal("bob", "Bob Wants Pin");
    const res = await assign("bob", bobs, "team", 1);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("version_rule_not_allowed");
    expect((await assign("bob", bobs, "team", "latest")).status).toBe(201);
    const alices = await personal("alice", "Alice Pins");
    const pinned = await assign("alice", alices, "team", 1);
    expect(pinned.status).toBe(201);
    expect(pinned.json.entry).toMatchObject({ versionRule: "pinned", pinnedVersion: 1 });
  });

  it("refuses to approve a proposal of an archived agent", async () => {
    const agent = await personal("carol", "Carol Archived");
    expect((await assign("carol", agent, "team")).status).toBe(202);
    await sql(`UPDATE site_agents SET archived_at = now() WHERE id = $1`, [agent]);
    const res = await teamPut("alice", agent, { state: "active" });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("agent_archived");
  });

  it("an owner who left a team withdraws from its roster (?teamId), then can delete", async () => {
    await sql(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder')`, [
      finance,
      ids.dave,
    ]);
    expect((await as.dave.put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
    as.dave.team = finance;
    const draft = await personal("dave", "Dave Leaver", false);
    expect((await assign("dave", draft, "team")).status).toBe(201);
    expect((await as.dave.put("/v1/me/teams/active", { teamId: marketing })).status).toBe(200);
    as.dave.team = marketing;
    await sql(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [finance, ids.dave]);
    expect((await as.dave.request("DELETE", `/v1/agents/${draft}`)).json.code).toBe(
      "agent_rostered",
    );
    const reach = rowOf(await roster("dave", "personal"), draft)?.reach;
    expect(reach).toEqual([expect.objectContaining({ teamName: "Finance", state: "active" })]);
    // Without teamId it means the active team, where the agent isn't.
    expect((await withdraw("dave", draft, "team")).status).toBe(404);
    expect(
      (await as.dave.request("DELETE", `/v1/agents/${draft}/assignments/site?teamId=${finance}`))
        .status,
    ).toBe(400);
    const out = await as.dave.request(
      "DELETE",
      `/v1/agents/${draft}/assignments/team?teamId=${finance}`,
    );
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    expect(out.json.entry).toMatchObject({ teamId: finance, state: "removed" });
    expect((await audited("agent.roster.withdrawn", draft))[0]?.team_id).toBe(finance);
    // Someone else can't withdraw it.
    expect(
      (await as.bob.request("DELETE", `/v1/agents/${draft}/assignments/team?teamId=${finance}`))
        .status,
    ).toBe(404);
    expect((await as.dave.request("DELETE", `/v1/agents/${draft}`)).status).toBe(204);
  });
});

describe("binding, delete, caps and rate (AR8, §6.3, §6.8, ac-3)", () => {
  it("refuses a bound agent outside its team (422 agent_bound_to_team)", async () => {
    const agent = await personal("carol", "Carol Bound");
    await sql(`UPDATE site_agents SET bound_team_id = $1 WHERE id = $2`, [marketing, agent]);
    const team = await assign("carol", agent, "team");
    expect(team.status).toBe(422);
    expect(team.json.code).toBe("agent_bound_to_team");
    expect((await assign("carol", agent, "site")).json.code).toBe("agent_bound_to_team");
    await sql(`UPDATE site_agents SET bound_team_id = $1 WHERE id = $2`, [finance, agent]);
    expect((await assign("carol", agent, "team")).status).toBe(202);
    expect((await assign("carol", agent, "site")).status).toBe(422);
  });

  it("refuses to delete a never-published agent while it is proposed (409 agent_rostered)", async () => {
    const draft = await personal("carol", "Carol Draft", false);
    expect((await assign("carol", draft, "team")).status).toBe(202);
    const refused = await as.carol.request("DELETE", `/v1/agents/${draft}`);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("agent_rostered");
    expect((await withdraw("carol", draft, "team")).status).toBe(200);
    expect((await as.carol.request("DELETE", `/v1/agents/${draft}`)).status).toBe(204);
  });

  it("caps assigned entries per team roster at 200", async () => {
    const filler = Array.from({ length: 200 }, () => randomUUID());
    await sql(
      `INSERT INTO team_agent_roster (team_id, site_agent_id, assigned_by)
       SELECT $1, unnest($2::uuid[]), $3`,
      [marketing, filler, ids.dave],
    );
    try {
      const agent = await personal("dave", "Dave Full");
      const res = await assign("dave", agent, "team");
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("roster_limit");
      // Fillers are inert: entries of agents that don't exist never show on the tab.
      expect(await roster("dave", "team")).not.toContainEqual(
        expect.objectContaining({ agentId: filler[0] }),
      );
    } finally {
      await sql(`DELETE FROM team_agent_roster WHERE site_agent_id = ANY($1::uuid[])`, [filler]);
    }
  });

  it("rate-limits roster writes to 60 per user per 10 minutes", async () => {
    const agent = await personal("dave", "Dave Rate");
    await sql(
      `INSERT INTO rate_limits (key, count, last_request) VALUES ($1, 60, $2)
       ON CONFLICT (key) DO UPDATE SET count = 60, last_request = $2`,
      [`kobe:agent-roster:${ids.dave}`, Date.now()],
    );
    const res = await assign("dave", agent, "team");
    expect(res.status).toBe(429);
    expect(res.json.code).toBe("rate_limited");
    await sql(`DELETE FROM rate_limits WHERE key = $1`, [`kobe:agent-roster:${ids.dave}`]);
  });
});

describe("the roster read (AR1, AR2, §6.8)", () => {
  it("lists team-owned agents on the Team tab and pages by (name, id)", async () => {
    const created = await as.bob.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Aardvark Team" },
      prompt: "x",
    });
    expect(created.status).toBe(201);
    const rows = await roster("carol", "team");
    expect(rowOf(rows, created.json.agent.id)).toMatchObject({
      kind: "team_owned",
      status: "not_published",
    });
    const names = rows.map((r) => r.name);
    expect(names).toEqual([...names].sort());
    const first = await as.carol.get("/v1/agents/roster?tab=team&limit=1");
    expect(first.json.rows).toHaveLength(1);
    const next = await as.carol.get(
      `/v1/agents/roster?tab=team&limit=1&cursor=${first.json.nextCursor as string}`,
    );
    expect(next.json.rows[0].agentId).toBe(rows[1]?.agentId);
    expect((await as.carol.get("/v1/agents/roster?tab=team&cursor=nope")).status).toBe(400);
    expect((await as.carol.get("/v1/agents/roster?tab=all")).status).toBe(400);
  });

  it("Personal lists only the caller's own agents with their actions", async () => {
    const carols = await personal("carol", "Carol Fresh");
    const bobs = await personal("bob", "Bob Fresh");
    const rows = await roster("carol", "personal");
    expect(rows.every((r) => r.kind === "personal")).toBe(true);
    expect(rowOf(rows, bobs)).toBeUndefined();
    expect(rowOf(rows, carols)).toMatchObject({
      reach: [],
      actions: expect.objectContaining({
        edit: true,
        assignTeam: "propose",
        assignSite: "propose",
      }),
    });
    expect(rowOf(await roster("bob", "personal"), bobs)?.actions).toMatchObject({
      assignTeam: "direct",
    });
  });

  it("gives team admins the inventory's usage on Team and Site rows, nobody else (KOBE-570, AR12)", async () => {
    const created = await as.bob.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Usage Team" },
      prompt: "x",
    });
    expect(created.status).toBe(201);
    const teamAgent = created.json.agent.id as string;
    await as.bob.request("POST", `/v1/agents/${teamAgent}/publish`, {}, ANY);
    const lent = await personal("bob", "Usage Lent");
    expect((await assign("bob", lent, "team")).status).toBe(201);
    const thread = await as.bob.post("/v1/threads", { agent_id: teamAgent });
    expect(thread.status, JSON.stringify(thread.json)).toBe(201);
    await sql(
      `INSERT INTO runs (team_id, thread_id, trigger) VALUES ($1, $2, 'user'), ($1, $2, 'user')`,
      [finance, thread.json.thread_id],
    );
    const usage = (rows: Row[], id: string) =>
      (rowOf(rows, id) as (Row & { usage?: Record<string, unknown> }) | undefined)?.usage;
    const team = await roster("alice", "team");
    expect(usage(team, teamAgent)).toMatchObject({
      runCount: 2,
      schedules: [],
      orbitScore: { status: "none" },
      canExport: true,
    });
    expect(usage(team, teamAgent)?.lastRunAt).toEqual(expect.any(String));
    // Someone else's personal agent: usage, but not the admin's to export (as the inventory).
    expect(usage(team, lent)).toMatchObject({ runCount: 0, tokens: 0, canExport: false });
    const site = await roster("alice", "site");
    expect(site.every((r) => usage(site, r.agentId) !== undefined)).toBe(true);
    // Builders, members and the Personal tab never carry it.
    expect((await roster("bob", "team")).some((r) => usage([r], r.agentId))).toBe(false);
    expect((await roster("carol", "site")).some((r) => usage([r], r.agentId))).toBe(false);
    expect((await roster("alice", "personal")).some((r) => usage([r], r.agentId))).toBe(false);
  });
});
