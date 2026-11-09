import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { KOBE_GALLERY_KEY } from "./gallery/definitions.js";
import { withTeam } from "@kobe/db";
import { defaultNewThreadPin } from "./agents/default-agent.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * The roster views KOBE-571 adds on the server (spec agents-roster AR8, AR14, AR15, §5, §6.4,
 * §6.7, §7.7): the read-only definition read from a roster per role, the declined marker on the
 * owner's Reach, `actions.adopt`, the fork's binding and lineage on rows, the picker's groups and
 * the team default agent. Own throwaway database.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";
const ANY = { "if-match": "*" };

type Person = "sam" | "alice" | "bob" | "carol" | "dave";
// Finance: alice team_admin, bob contributor, carol member, sam member (and site admin).
// Marketing: dave contributor, alice team_admin.
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
    setupToken: "setup-token-for-roster-views-tests-0",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const user = await deps.createUserWithPassword(
      { email: `${who}@views.test`, name: who, password: PASSWORD },
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
    [finance, "bob", "contributor"],
    [finance, "carol", "member"],
    [finance, "sam", "member"],
    [marketing, "dave", "contributor"],
    [marketing, "alice", "team_admin"],
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
      email: `${who}@views.test`,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    as[who] = b;
    await activate(who, who === "dave" ? marketing : finance);
  }
});

afterAll(async () => {
  await deps?.close();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

async function activate(who: Person, team: string): Promise<void> {
  as[who].team = undefined;
  const res = await as[who].put("/v1/me/teams/active", { teamId: team });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  as[who].team = team;
}

async function personal(who: Person, name: string, publish = true): Promise<string> {
  const created = await as[who].post("/v1/agents", {
    scope: "personal",
    frontmatter: { name },
    prompt: `You are ${name}.`,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  if (publish) await publish_(who, id);
  return id;
}

async function publish_(who: Person, id: string): Promise<void> {
  const pub = await as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
}

async function editDraft(who: Person, id: string, prompt: string): Promise<void> {
  const res = await as[who].request(
    "PUT",
    `/v1/agents/${id}`,
    { frontmatter: { name: "Edited" }, prompt },
    ANY,
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

const assign = (who: Person, id: string, target: "team" | "site") =>
  as[who].post(`/v1/agents/${id}/assignments`, { target });
const teamPut = (who: Person, id: string, body: object) =>
  as[who].put(`/v1/team/agent-roster/${id}`, body);

type Row = {
  agentId: string;
  actions: Record<string, unknown>;
  reach?: { target: string; state: string; note: string | null; declined?: boolean }[];
  forkBoundTeamId?: string | null;
  forkedFrom?: {
    agentId: string;
    version: number | null;
    name: string | null;
    kind: string | null;
  };
};

async function rowOf(who: Person, tab: "personal" | "team" | "site", id: string): Promise<Row> {
  const res = await as[who].get(`/v1/agents/roster?tab=${tab}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const row = (res.json.rows as Row[]).find((r) => r.agentId === id);
  if (!row) throw new Error(`${who} sees no ${tab} row for ${id}`);
  return row;
}

async function audited(action: string) {
  return sql<{ team_id: string | null; target: Record<string, unknown> }>(
    `SELECT team_id, target FROM audit_log WHERE action = $1 ORDER BY seq`,
    [action],
  );
}

describe("View from a roster: read-only definition per role (AR14, §5)", () => {
  it("team entry: builders and admins read the version in effect, members and other teams don't", async () => {
    const agent = await personal("bob", "Bob Team");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    await editDraft("bob", agent, "Bob's v2 prompt.");
    await publish_("bob", agent);
    // Alice pins v1; Bob's draft moves on.
    expect((await teamPut("alice", agent, { state: "active", versionRule: 1 })).status).toBe(200);
    await editDraft("bob", agent, "Secret draft.");

    const read = await as.alice.get(`/v1/agents/${agent}`);
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    expect(read.json.agent).toMatchObject({
      id: agent,
      scope: "personal",
      ownerUserId: ids.bob,
      prompt: "You are Bob Team.",
      currentVersion: 2,
      versionInEffect: 1,
      canEdit: false,
      canPublish: false,
      canExport: false,
    });
    const versions = await as.alice.get(`/v1/agents/${agent}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.json.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const v2 = await as.alice.get(`/v1/agents/${agent}/versions/2`);
    expect(v2.status).toBe(200);
    expect(JSON.stringify(v2.json)).toContain("Bob's v2 prompt.");
    expect(JSON.stringify(read.json)).not.toContain("Secret draft.");

    // Read-only: no writes, no export, no publish through the read.
    expect(
      (await as.alice.request("PUT", `/v1/agents/${agent}`, { prompt: "x" }, ANY)).status,
    ).toBe(404);
    expect((await as.alice.request("POST", `/v1/agents/${agent}/publish`, {}, ANY)).status).toBe(
      404,
    );
    expect((await as.alice.get(`/v1/agents/${agent}/export`)).status).toBe(404);

    // A member (no build) and a builder of another team read nothing (404, no oracle).
    expect((await as.carol.get(`/v1/agents/${agent}`)).status).toBe(404);
    expect((await as.carol.get(`/v1/agents/${agent}/versions`)).status).toBe(404);
    expect((await as.dave.get(`/v1/agents/${agent}`)).status).toBe(404);

    // Withdrawn: nobody else reads it any more.
    expect((await as.bob.delete(`/v1/agents/${agent}/assignments/team`)).status).toBe(200);
    expect((await as.alice.get(`/v1/agents/${agent}`)).status).toBe(404);
  });

  it("shows the entry of the tab it was opened from; never-rostered agents stay 404", async () => {
    const agent = await personal("bob", "Bob Both");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    expect((await teamPut("alice", agent, { state: "active", versionRule: 1 })).status).toBe(200);
    expect((await assign("bob", agent, "site")).status).toBe(202);
    expect((await as.sam.put(`/v1/site/agent-roster/${agent}`, { state: "active" })).status).toBe(
      200,
    );
    await editDraft("bob", agent, "Bob's v2.");
    await publish_("bob", agent);
    // Team tab (default): the team entry's pin; Site tab: the site entry's latest.
    expect((await as.alice.get(`/v1/agents/${agent}`)).json.agent.versionInEffect).toBe(1);
    const fromSite = await as.alice.get(`/v1/agents/${agent}?from=site`);
    expect(fromSite.json.agent).toMatchObject({ versionInEffect: 2, prompt: "Bob's v2." });
    // A member (no build) reads the site entry either way.
    expect((await as.carol.get(`/v1/agents/${agent}`)).json.agent.versionInEffect).toBe(2);

    const hidden = await personal("carol", "Carol Hidden");
    expect((await as.alice.get(`/v1/agents/${hidden}`)).status).toBe(404);
    expect((await as.alice.get(`/v1/agents/${hidden}/versions`)).status).toBe(404);
    expect((await as.sam.get(`/v1/agents/${hidden}?from=site`)).status).toBe(404);
  });

  it("site entry: every member of every team reads it (use)", async () => {
    const agent = await personal("sam", "Sam Site");
    expect((await assign("sam", agent, "site")).status).toBe(201);
    for (const who of ["carol", "dave"] as const) {
      const read = await as[who].get(`/v1/agents/${agent}`);
      expect(read.status, who).toBe(200);
      expect(read.json.agent).toMatchObject({ versionInEffect: 1, canEdit: false });
      expect((await as[who].get(`/v1/agents/${agent}/versions`)).status).toBe(200);
    }
  });
});

describe("Declined marker and actions.adopt on rows (§6.4, AR10)", () => {
  it("tells a decline from a removal and a withdrawal on the owner's Reach", async () => {
    const declined = await personal("carol", "Carol Proposal");
    expect((await assign("carol", declined, "team")).status).toBe(202);
    expect((await teamPut("alice", declined, { state: "removed" })).status).toBe(200);
    const reach = (await rowOf("carol", "personal", declined)).reach ?? [];
    expect(reach).toContainEqual(
      expect.objectContaining({ target: "team", state: "removed", note: null, declined: true }),
    );

    const removed = await personal("bob", "Bob Removed");
    expect((await assign("bob", removed, "team")).status).toBe(201);
    expect((await teamPut("alice", removed, { state: "removed" })).status).toBe(200);
    expect((await rowOf("bob", "personal", removed)).reach).toContainEqual(
      expect.objectContaining({ state: "removed", declined: false }),
    );

    // Approved, then removed: the approval's decision stays, still not a decline.
    const approved = await personal("carol", "Carol Approved");
    expect((await assign("carol", approved, "team")).status).toBe(202);
    expect((await teamPut("alice", approved, { state: "active" })).status).toBe(200);
    expect((await teamPut("alice", approved, { state: "removed" })).status).toBe(200);
    expect((await rowOf("carol", "personal", approved)).reach).toContainEqual(
      expect.objectContaining({ state: "removed", declined: false }),
    );

    // A row declined before KOBE-571 (removedAt written) can't be told from a removal: not shown.
    const legacy = await personal("carol", "Carol Legacy");
    expect((await assign("carol", legacy, "team")).status).toBe(202);
    await sql(
      `UPDATE team_agent_roster SET state = 'removed', decided_by = $2, decided_at = now(),
              removed_at = now() WHERE site_agent_id = $1`,
      [legacy, ids.alice],
    );
    expect((await rowOf("carol", "personal", legacy)).reach).toContainEqual(
      expect.objectContaining({ state: "removed", declined: false }),
    );

    const withdrawn = await personal("bob", "Bob Withdrawn");
    expect((await assign("bob", withdrawn, "team")).status).toBe(201);
    expect((await as.bob.delete(`/v1/agents/${withdrawn}/assignments/team`)).status).toBe(200);
    expect((await rowOf("bob", "personal", withdrawn)).reach).toContainEqual(
      expect.objectContaining({ state: "removed", declined: false }),
    );
  });

  it("offers Adopt to the roster's admins on assigned entries only", async () => {
    const agent = await personal("bob", "Bob Adoptable");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    expect((await rowOf("alice", "team", agent)).actions.adopt).toBe(true);
    expect((await rowOf("bob", "team", agent)).actions.adopt).toBe(false);
    expect((await rowOf("carol", "team", agent)).actions.adopt).toBe(false);

    const proposal = await personal("carol", "Carol Pending");
    expect((await assign("carol", proposal, "team")).status).toBe(202);
    expect((await rowOf("alice", "team", proposal)).actions.adopt).toBe(false);

    const site = await personal("bob", "Bob Site");
    expect((await assign("bob", site, "site")).status).toBe(202);
    expect((await as.sam.put(`/v1/site/agent-roster/${site}`, { state: "active" })).status).toBe(
      200,
    );
    expect((await rowOf("sam", "site", site)).actions.adopt).toBe(true);
    expect((await rowOf("alice", "site", site)).actions.adopt).toBe(false);
  });
});

describe("Fork binding and lineage on rows (AR8, §6.7)", () => {
  it("says where a fork lands and shows Forked from where the viewer may read the source", async () => {
    const agent = await personal("bob", "Bob Source");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    expect((await rowOf("alice", "team", agent)).forkBoundTeamId).toBe(finance);

    const res = await as.alice.post(`/v1/agents/${agent}/fork`, { name: "Alice's copy" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.agent.name).toBe("Alice's copy");
    expect(res.json.boundTeamId).toBe(finance);
    const copy = res.json.agent.id as string;
    expect((await rowOf("alice", "personal", copy)).forkedFrom).toEqual({
      agentId: agent,
      version: 1,
      name: "Bob Source",
      kind: "personal",
    });

    // Once withdrawn, Alice may no longer read the source: it stays anonymous.
    expect((await as.bob.delete(`/v1/agents/${agent}/assignments/team`)).status).toBe(200);
    expect((await rowOf("alice", "personal", copy)).forkedFrom).toEqual({
      agentId: agent,
      version: 1,
      name: null,
      kind: null,
    });
  });

  it("a gallery row forks unbound", async () => {
    const [seeded] = await seedGalleryAgents(deps.database.db, [
      { key: "views-shelf", generation: 1, file: "---\nname: Shelf\n---\nShelf.\n" },
    ]);
    const id = seeded?.agentId ?? "";
    expect((await rowOf("carol", "site", id)).forkBoundTeamId).toBeNull();
    const res = await as.carol.post(`/v1/agents/${id}/fork`, {});
    expect(res.status).toBe(201);
    expect((await rowOf("carol", "personal", res.json.agent.id)).forkedFrom).toMatchObject({
      agentId: id,
      name: "Shelf",
      kind: "gallery",
    });
  });
});

describe("Team default agent (§7.7) and picker groups (AR15)", () => {
  let kobe = "";
  let lent = "";
  let mine = "";

  beforeAll(async () => {
    const [seeded] = await seedGalleryAgents(deps.database.db, [
      { key: KOBE_GALLERY_KEY, generation: 1, file: "---\nname: Kobe\n---\nYou are Kobe.\n" },
    ]);
    kobe = seeded?.agentId ?? "";
    lent = await personal("bob", "Bob Default");
    expect((await assign("bob", lent, "team")).status).toBe(201);
    mine = await personal("carol", "Carol Private");
  });

  const pinOf = (who: Person, teamId: string) =>
    withTeam(deps.database.db, teamId, (tx) =>
      defaultNewThreadPin(tx, { teamId, userId: ids[who] }),
    );

  it("lists the roster's choices to members; team admins only change it, from the roster", async () => {
    const read = await as.carol.get("/v1/team/default-agent");
    expect(read.status).toBe(200);
    expect(read.json.agentId).toBeNull();
    const options = read.json.options as { agentId: string; group: string }[];
    expect(options).toContainEqual(expect.objectContaining({ agentId: lent, group: "team" }));
    expect(options).toContainEqual(expect.objectContaining({ agentId: kobe, group: "site" }));
    expect(options.some((o) => o.agentId === mine)).toBe(false);

    expect((await as.bob.put("/v1/team/default-agent", { agentId: lent })).status).toBe(403);
    expect((await as.carol.put("/v1/team/default-agent", { agentId: lent })).status).toBe(403);
    const private_ = await as.alice.put("/v1/team/default-agent", { agentId: mine });
    expect(private_.status).toBe(422);
    expect(private_.json.code).toBe("agent_not_eligible");
    expect((await as.alice.put("/v1/team/default-agent", { agentId: "kobe" })).status).toBe(400);
  });

  it("new threads in that team use it; other teams and an unset team use the site default", async () => {
    expect((await pinOf("carol", finance))?.agentId).toBe(kobe);
    const set = await as.alice.put("/v1/team/default-agent", { agentId: lent });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.agentId).toBe(lent);
    expect(await audited("team.default_agent_changed")).toEqual([
      { team_id: finance, target: { agentId: lent, previousAgentId: null } },
    ]);
    // Setting it again changes nothing and logs nothing.
    expect((await as.alice.put("/v1/team/default-agent", { agentId: lent })).status).toBe(200);
    expect(await audited("team.default_agent_changed")).toHaveLength(1);

    expect(await pinOf("carol", finance)).toMatchObject({ agentId: lent, agentVersion: 1 });
    expect((await pinOf("dave", marketing))?.agentId).toBe(kobe);
    const runnable = await as.carol.get("/v1/agents/runnable?limit=200");
    const listed = runnable.json.agents as { id: string; default?: true; group: string }[];
    expect(listed.filter((a) => a.default).map((a) => a.id)).toEqual([lent]);

    // Withdrawn: the setting stays but is unavailable, and the site default applies.
    expect((await as.bob.delete(`/v1/agents/${lent}/assignments/team`)).status).toBe(200);
    const after = await as.carol.get("/v1/team/default-agent");
    expect(after.json).toMatchObject({ agentId: lent, unavailable: true });
    expect((await pinOf("carol", finance))?.agentId).toBe(kobe);
    expect((await assign("bob", lent, "team")).status).toBe(201);

    const cleared = await as.alice.put("/v1/team/default-agent", { agentId: null });
    expect(cleared.json.agentId).toBeNull();
    expect((await audited("team.default_agent_changed")).at(-1)?.target).toEqual({
      agentId: null,
      previousAgentId: lent,
    });
    expect((await pinOf("carol", finance))?.agentId).toBe(kobe);
  });

  it("falls back to the site default when the team default is suspended or archived", async () => {
    const created = await as.bob.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Team Default" },
      prompt: "You help the team.",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const owned = created.json.agent.id as string;
    await publish_("bob", owned);
    expect((await as.alice.put("/v1/team/default-agent", { agentId: owned })).status).toBe(200);
    expect((await pinOf("carol", finance))?.agentId).toBe(owned);

    const status = (s: string) =>
      as.alice.request("PUT", `/v1/agents/${owned}/status`, { status: s }, ANY);
    expect((await status("suspended")).status).toBe(200);
    expect((await pinOf("carol", finance))?.agentId).toBe(kobe);
    expect((await as.carol.get("/v1/team/default-agent")).json.unavailable).toBe(true);
    expect((await status("active")).status).toBe(200);
    expect((await pinOf("carol", finance))?.agentId).toBe(owned);

    // Published, so deleting archives it.
    expect((await as.bob.request("DELETE", `/v1/agents/${owned}`, undefined, ANY)).status).toBe(
      200,
    );
    expect((await pinOf("carol", finance))?.agentId).toBe(kobe);
    expect((await as.carol.get("/v1/team/default-agent")).json.unavailable).toBe(true);
    expect((await as.alice.put("/v1/team/default-agent", { agentId: null })).status).toBe(200);
  });

  it("refuses another team's team-owned agent as the default (422)", async () => {
    const created = await as.dave.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Marketing Only" },
      prompt: "Marketing.",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const theirs = created.json.agent.id as string;
    await publish_("dave", theirs);
    const res = await as.alice.put("/v1/team/default-agent", { agentId: theirs });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("agent_not_eligible");
  });

  it("groups the runnable list Personal, Team, Site", async () => {
    const runnable = await as.carol.get("/v1/agents/runnable?limit=200");
    expect(runnable.status).toBe(200);
    const group = (id: string) =>
      (runnable.json.agents as { id: string; group: string }[]).find((a) => a.id === id)?.group;
    expect(group(mine)).toBe("personal");
    expect(group(lent)).toBe("team");
    expect(group(kobe)).toBe("site");
  });
});
