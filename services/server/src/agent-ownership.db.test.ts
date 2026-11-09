import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * Fork lands in Personal with binding, transfer, adopt (KOBE-568, spec agents-roster AR8, AR10,
 * AR16, §5, §6.7-6.9). Own throwaway database.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";
const ANY = { "if-match": "*" };

type Person = "sam" | "alice" | "bob" | "carol" | "dave";
// Finance: alice team_admin, bob builder, carol member, sam member (and site admin).
// Marketing: dave builder, alice team_admin.
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
    setupToken: "setup-token-for-ownership-tests-0",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const user = await deps.createUserWithPassword(
      { email: `${who}@own.test`, name: who, password: PASSWORD },
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
      email: `${who}@own.test`,
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

const fork = (who: Person, id: string, body: object = {}) =>
  as[who].post(`/v1/agents/${id}/fork`, body);
const assign = (who: Person, id: string, target: "team" | "site") =>
  as[who].post(`/v1/agents/${id}/assignments`, { target });

async function audited(action: string, agentId: string) {
  return sql<{ team_id: string | null; target: Record<string, unknown> }>(
    `SELECT team_id, target FROM audit_log WHERE action = $1 AND target->>'agentId' = $2 ORDER BY seq`,
    [action, agentId],
  );
}

async function boundTeam(id: string): Promise<string | null> {
  const [row] = await sql<{ bound_team_id: string | null }>(
    `SELECT bound_team_id FROM site_agents WHERE id = $1`,
    [id],
  );
  return row?.bound_team_id ?? null;
}

describe("fork lands in Personal (AR8, ac-1)", () => {
  it("a gallery fork is the member's own unbound agent; a scope is ignored with a warning", async () => {
    const [seeded] = await seedGalleryAgents(deps.database.db, [
      { key: "own-gallery", generation: 1, file: "---\nname: Shelf\n---\nPublished shelf.\n" },
    ]);
    const id = seeded?.agentId ?? "";
    const res = await fork("carol", id, { scope: "team" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.agent).toMatchObject({
      scope: "personal",
      ownerUserId: ids.carol,
      prompt: "Published shelf.",
      forkedFrom: { agentId: id, version: 1 },
      canEdit: true,
    });
    expect(res.json.boundTeamId).toBeNull();
    expect(res.json.warnings).toContainEqual(expect.objectContaining({ path: "scope" }));
    expect(await boundTeam(res.json.agent.id)).toBeNull();
    const created = await audited("agent.created", res.json.agent.id);
    expect(created).toEqual([
      {
        team_id: null,
        target: {
          agentId: res.json.agent.id,
          scope: "personal",
          slug: "own-gallery",
          source: "fork",
          forkedFrom: id,
          forkedFromVersion: 1,
          boundTeamId: null,
        },
      },
    ]);
    // Without a scope there is no warning.
    const plain = await fork("carol", id);
    expect(plain.json.warnings).toEqual([]);
  });

  it("a site-assigned agent forks unbound from its published version (members included)", async () => {
    const agent = await personal("sam", "Sam Site");
    expect((await assign("sam", agent, "site")).status).toBe(201);
    await editDraft("sam", agent, "Unpublished draft.");
    const res = await fork("carol", agent);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.agent).toMatchObject({
      scope: "personal",
      ownerUserId: ids.carol,
      prompt: "You are Sam Site.",
      forkedFrom: { agentId: agent, version: 1 },
    });
    expect(res.json.boundTeamId).toBeNull();
    // Dave, in another team, reads site-assigned agents too.
    expect((await fork("dave", agent)).status).toBe(201);
  });

  it("team content forks bound to the team; members can't fork it (403)", async () => {
    const assigned = await personal("bob", "Bob Assigned");
    expect((await assign("bob", assigned, "team")).status).toBe(201);
    const owned = await as.bob.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Team Owned" },
      prompt: "Team v1.",
    });
    const ownedId = owned.json.agent.id as string;
    await publish_("bob", ownedId);
    for (const id of [assigned, ownedId]) {
      const member = await fork("carol", id);
      expect(member.status, JSON.stringify(member.json)).toBe(403);
      const res = await fork("alice", id);
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      expect(res.json.agent).toMatchObject({ scope: "personal", ownerUserId: ids.alice });
      expect(res.json.boundTeamId).toBe(finance);
      expect(await boundTeam(res.json.agent.id)).toBe(finance);
      expect((await audited("agent.created", res.json.agent.id))[0]?.target.boundTeamId).toBe(
        finance,
      );
    }
    // Marketing can't see Finance's content at all.
    expect((await fork("dave", ownedId)).status).toBe(404);
    expect((await fork("dave", assigned)).status).toBe(404);
  });

  it("binding is permanent and enforced on assign: site and other teams 422, own team 201", async () => {
    const assigned = await personal("bob", "Bob Bind");
    expect((await assign("bob", assigned, "team")).status).toBe(201);
    const first = await fork("alice", assigned);
    const bound = first.json.agent.id as string;
    await publish_("alice", bound);
    // A copy of a copy stays bound, even forked from Personal.
    const copy = await fork("alice", bound);
    expect(copy.json.boundTeamId).toBe(finance);
    const site = await assign("alice", bound, "site");
    expect(site.status, JSON.stringify(site.json)).toBe(422);
    expect(site.json.code).toBe("agent_bound_to_team");
    await activate("alice", marketing);
    try {
      const other = await assign("alice", bound, "team");
      expect(other.status).toBe(422);
      expect(other.json.code).toBe("agent_bound_to_team");
    } finally {
      await activate("alice", finance);
    }
    expect((await assign("alice", bound, "team")).status).toBe(201);
  });

  it("own agents fork from the draft only while unpublished; others' unpublished entries 422", async () => {
    const draft = await personal("bob", "Bob Draft", false);
    const own = await fork("bob", draft);
    expect(own.status, JSON.stringify(own.json)).toBe(201);
    expect(own.json.agent).toMatchObject({
      prompt: "You are Bob Draft.",
      forkedFrom: { agentId: draft, version: null },
    });
    // Published: the published version, not the newer draft.
    const published = await personal("bob", "Bob Pub");
    await editDraft("bob", published, "Newer draft.");
    const fromPublished = await fork("bob", published);
    expect(fromPublished.json.agent).toMatchObject({
      prompt: "You are Bob Pub.",
      forkedFrom: { agentId: published, version: 1 },
    });
    // Someone else's never-published team entry has nothing to copy.
    expect((await assign("bob", draft, "team")).status).toBe(201);
    const none = await fork("alice", draft);
    expect(none.status).toBe(422);
    expect(none.json.code).toBe("agent_not_published");
    // Someone else's agent on no roster does not exist for the caller.
    expect((await fork("alice", published)).status).toBe(404);
  });
});

describe("transfer (AR10, ac-2)", () => {
  it("needs the recipient's acceptance; the agent and its entries move, pins stay", async () => {
    const agent = await personal("bob", "Bob Transfer");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    // Only another active member of the active team.
    expect(
      (await as.bob.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.dave })).json.code,
    ).toBe("transfer_recipient_invalid");
    expect((await as.bob.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.bob })).status).toBe(
      422,
    );
    // Not the owner: not found.
    expect(
      (await as.alice.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.carol })).status,
    ).toBe(404);
    const offer = await as.bob.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.carol });
    expect(offer.status, JSON.stringify(offer.json)).toBe(201);
    expect(offer.json.transfer).toMatchObject({
      agentId: agent,
      fromUserId: ids.bob,
      toUserId: ids.carol,
      teamId: finance,
    });
    // Both parties see it: the owner's read, the recipient's read, and the lists.
    expect((await as.bob.get(`/v1/agents/${agent}`)).json.transfer).toMatchObject({
      toUserId: ids.carol,
    });
    const offered = await as.carol.get(`/v1/agents/${agent}`);
    expect(offered.status, JSON.stringify(offered.json)).toBe(200);
    expect(offered.json.agent).toMatchObject({ id: agent, canEdit: false });
    expect(offered.json.agent).not.toHaveProperty("prompt");
    expect(offered.json.transfer).toMatchObject({ fromUserId: ids.bob });
    expect((await as.carol.get("/v1/agents/transfers")).json.incoming).toEqual([
      expect.objectContaining({ agentId: agent, name: "Bob Transfer", slug: "bob-transfer" }),
    ]);
    expect((await as.bob.get("/v1/agents/transfers")).json.outgoing).toHaveLength(1);
    expect((await as.alice.get(`/v1/agents/${agent}`)).status).toBe(404);
    // Nothing moves until the recipient accepts; nobody else can.
    expect((await as.alice.post(`/v1/agents/${agent}/transfer/accept`)).status).toBe(404);
    expect((await as.bob.post(`/v1/agents/${agent}/transfer/accept`)).status).toBe(404);
    const thread = await as.bob.post("/v1/threads", { agent_id: agent });
    expect(thread.status, JSON.stringify(thread.json)).toBe(201);
    const accepted = await as.carol.post(`/v1/agents/${agent}/transfer/accept`);
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(accepted.json).toEqual({ agentId: agent, ownerUserId: ids.carol, fromUserId: ids.bob });
    const mine = await as.carol.get(`/v1/agents/${agent}`);
    expect(mine.json.agent).toMatchObject({ ownerUserId: ids.carol, canEdit: true });
    expect(mine.json.transfer).toBeNull();
    expect((await as.bob.get(`/v1/agents/${agent}`)).status).toBe(404);
    const [entry] = await sql<{ state: string; assigned_by: string }>(
      `SELECT state, assigned_by FROM team_agent_roster WHERE site_agent_id = $1`,
      [agent],
    );
    expect(entry).toEqual({ state: "active", assigned_by: ids.bob });
    const [pin] = await sql<{ agent_id: string; agent_version: number }>(
      `SELECT agent_id, agent_version FROM threads WHERE id = $1`,
      [thread.json.thread_id],
    );
    expect(pin).toEqual({ agent_id: agent, agent_version: 1 });
    // The new owner withdraws the entry; the old one can't.
    expect((await as.bob.request("DELETE", `/v1/agents/${agent}/assignments/team`)).status).toBe(
      404,
    );
    expect((await as.carol.request("DELETE", `/v1/agents/${agent}/assignments/team`)).status).toBe(
      200,
    );
    expect(await audited("agent.transferred", agent)).toEqual([
      {
        team_id: finance,
        target: {
          agentId: agent,
          scope: "personal",
          slug: "bob-transfer",
          fromUserId: ids.bob,
          toUserId: ids.carol,
        },
      },
    ]);
    expect((await audited("agent.transfer.requested", agent)).length).toBe(1);
  });

  it("the recipient declines or the owner cancels; a clash of slugs is 409", async () => {
    const agent = await personal("bob", "Bob Decline");
    expect(
      (await as.bob.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.carol })).status,
    ).toBe(201);
    expect((await as.alice.request("DELETE", `/v1/agents/${agent}/transfer`)).status).toBe(404);
    expect((await as.carol.request("DELETE", `/v1/agents/${agent}/transfer`)).status).toBe(204);
    expect((await as.carol.post(`/v1/agents/${agent}/transfer/accept`)).status).toBe(404);
    expect((await audited("agent.transfer.cancelled", agent))[0]?.target.by).toBe("recipient");
    const [declined] = await sql<{ state: string; team_id: string }>(
      `SELECT state, team_id FROM agent_transfers WHERE site_agent_id = $1`,
      [agent],
    );
    expect(declined).toEqual({ state: "declined", team_id: finance });
    expect(
      (await as.bob.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.carol })).status,
    ).toBe(201);
    expect((await as.bob.request("DELETE", `/v1/agents/${agent}/transfer`)).status).toBe(204);
    expect((await audited("agent.transfer.cancelled", agent))[1]?.target.by).toBe("owner");
    // Carol already has an agent with that slug.
    await personal("carol", "Bob Decline", false);
    await as.bob.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.carol });
    const clash = await as.carol.post(`/v1/agents/${agent}/transfer/accept`);
    expect(clash.status).toBe(409);
    expect(clash.json.code).toBe("slug_taken");
  });

  it("keeps one pending offer per agent: replaced in the team, refused from another (409)", async () => {
    const agent = await personal("alice", "Alice Two Teams");
    expect(
      (await as.alice.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.bob })).status,
    ).toBe(201);
    // A new offer in the same team replaces the old one (cancelled, kept as history).
    expect(
      (await as.alice.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.carol })).status,
    ).toBe(201);
    const incoming = async (who: Person) =>
      ((await as[who].get("/v1/agents/transfers")).json.incoming as { agentId: string }[]).filter(
        (t) => t.agentId === agent,
      );
    expect(await incoming("bob")).toEqual([]);
    expect(await incoming("carol")).toHaveLength(1);
    const rows = await sql<{ state: string; to_user_id: string }>(
      `SELECT state, to_user_id FROM agent_transfers WHERE site_agent_id = $1 ORDER BY created_at`,
      [agent],
    );
    expect(rows.map((r) => r.state)).toEqual(["cancelled", "pending"]);
    await activate("alice", marketing);
    try {
      const other = await as.alice.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.dave });
      expect(other.status).toBe(409);
      expect(other.json.code).toBe("invalid_transition");
    } finally {
      await activate("alice", finance);
    }
  });

  it("a bound agent goes only to a member of its bound team", async () => {
    const assigned = await personal("bob", "Bob Bound Source");
    expect((await assign("bob", assigned, "team")).status).toBe(201);
    const bound = (await fork("alice", assigned)).json.agent.id as string;
    await activate("alice", marketing);
    try {
      const res = await as.alice.post(`/v1/agents/${bound}/transfer`, { toUserId: ids.dave });
      expect(res.status).toBe(422);
      expect(res.json.code).toBe("agent_bound_to_team");
    } finally {
      await activate("alice", finance);
    }
    const ok = await as.alice.post(`/v1/agents/${bound}/transfer`, { toUserId: ids.bob });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
  });
});

describe("adopt (AR10, ac-3)", () => {
  it("a team admin copies the published version into a team-owned agent; the entry is removed", async () => {
    const agent = await personal("bob", "Bob Adopt");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    await editDraft("bob", agent, "Second.");
    await publish_("bob", agent);
    await editDraft("bob", agent, "Unpublished third.");
    const path = `/v1/team/agent-roster/${agent}/adopt`;
    expect((await as.bob.post(path)).status).toBe(403);
    expect((await as.carol.post(path)).status).toBe(403);
    expect((await as.dave.post(path)).status).toBe(403);
    const res = await as.alice.post(path);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.agent).toMatchObject({
      scope: "team",
      slug: "bob-adopt",
      forkedFrom: { agentId: agent, version: 2 },
    });
    expect(res.json.entry).toMatchObject({ state: "removed", decidedBy: ids.alice });
    const copy = await as.alice.get(`/v1/agents/${res.json.agent.id}`);
    // Published as v1 in the same transaction: the team keeps running it.
    expect(res.json.agent.currentVersion).toBe(1);
    expect(copy.json.agent).toMatchObject({
      scope: "team",
      ownerUserId: ids.alice,
      prompt: "Second.",
      currentVersion: 1,
      forkedFrom: { agentId: agent, version: 2 },
    });
    expect((await audited("agent.published", res.json.agent.id))[0]?.team_id).toBe(finance);
    const runnable = await as.carol.get("/v1/agents/runnable");
    expect(runnable.json.agents.map((a: { id: string }) => a.id)).toContain(res.json.agent.id);
    expect(await audited("agent.adopted", res.json.agent.id)).toEqual([
      {
        team_id: finance,
        target: {
          agentId: res.json.agent.id,
          scope: "team",
          slug: "bob-adopt",
          roster: "team",
          fromAgentId: agent,
          fromVersion: 2,
        },
      },
    ]);
    expect((await audited("agent.roster.removed", agent))[0]?.team_id).toBe(finance);
    // Adopting twice: the entry is removed now (409).
    const twice = await as.alice.post(path);
    expect(twice.status).toBe(409);
    expect(twice.json.code).toBe("invalid_transition");
  });

  it("a site admin copies a site entry into a gallery agent without a repository key", async () => {
    const agent = await personal("bob", "Bob Site Adopt");
    expect((await assign("bob", agent, "site")).status).toBe(202);
    const path = `/v1/site/agent-roster/${agent}/adopt`;
    // A proposal is not adopted (409).
    const proposed = await as.sam.post(path);
    expect(proposed.status).toBe(409);
    expect(proposed.json.code).toBe("invalid_transition");
    expect((await as.sam.put(`/v1/site/agent-roster/${agent}`, { state: "active" })).status).toBe(
      200,
    );
    expect((await as.alice.post(path)).status).toBe(403);
    const res = await as.sam.post(path);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.agent).toMatchObject({
      scope: "gallery",
      slug: "bob-site-adopt",
      currentVersion: 1,
      forkedFrom: { agentId: agent, version: 1 },
    });
    expect(res.json.entry).toMatchObject({ target: "site", state: "removed" });
    const [row] = await sql<Record<string, unknown>>(
      `SELECT scope, owner_user_id, gallery_key, forked_from_agent_id, forked_from_version
         FROM site_agents WHERE id = $1`,
      [res.json.agent.id],
    );
    expect(row).toEqual({
      scope: "gallery",
      owner_user_id: null,
      gallery_key: null,
      forked_from_agent_id: agent,
      forked_from_version: 1,
    });
    expect((await audited("agent.adopted", res.json.agent.id))[0]).toMatchObject({
      team_id: null,
      target: { scope: "gallery", roster: "site", fromAgentId: agent },
    });
  });
});

describe("refusals (review of #485)", () => {
  it("another team's admin can't adopt this team's entry; a removed entry is 409", async () => {
    const agent = await personal("bob", "Bob Walled Adopt");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    const path = `/v1/team/agent-roster/${agent}/adopt`;
    expect((await as.dave.post(path)).status).toBe(403);
    await activate("alice", marketing);
    try {
      const other = await as.alice.post(path);
      expect(other.status).toBe(404);
      expect(other.json.code).toBe("roster_entry_not_found");
    } finally {
      await activate("alice", finance);
    }
    expect((await as.bob.request("DELETE", `/v1/agents/${agent}/assignments/team`)).status).toBe(
      200,
    );
    const removed = await as.alice.post(path);
    expect(removed.status).toBe(409);
    expect(removed.json.code).toBe("invalid_transition");
  });

  it("never adopts a bound agent into the site", async () => {
    const source = await personal("bob", "Bob Bound Adopt Source");
    expect((await assign("bob", source, "team")).status).toBe(201);
    const bound = (await fork("alice", source)).json.agent.id as string;
    await publish_("alice", bound);
    // The API never puts a bound agent on the site roster; adopt refuses even if one got there.
    await sql(
      `INSERT INTO site_agent_roster (site_agent_id, state, assigned_by) VALUES ($1, 'active', $2)`,
      [bound, ids.alice],
    );
    const res = await as.sam.post(`/v1/site/agent-roster/${bound}/adopt`);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("agent_bound_to_team");
  });

  it("refuses an accept once the recipient left the team, or once the agent is archived", async () => {
    const agent = await personal("bob", "Bob Leaver");
    expect((await as.bob.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.sam })).status).toBe(
      201,
    );
    // Sam moves to Marketing and leaves Finance, the offer's team.
    await sql(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [
      marketing,
      ids.sam,
    ]);
    await activate("sam", marketing);
    await sql(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [finance, ids.sam]);
    try {
      const left = await as.sam.post(`/v1/agents/${agent}/transfer/accept`);
      expect(left.status, JSON.stringify(left.json)).toBe(422);
      expect(left.json.code).toBe("transfer_recipient_invalid");
      const [owner] = await sql<{ owner_user_id: string }>(
        `SELECT owner_user_id FROM site_agents WHERE id = $1`,
        [agent],
      );
      expect(owner?.owner_user_id).toBe(ids.bob);
    } finally {
      await sql(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [
        finance,
        ids.sam,
      ]);
      await activate("sam", finance);
      await sql(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
        marketing,
        ids.sam,
      ]);
    }
    const archived = await personal("bob", "Bob Archived");
    expect(
      (await as.bob.post(`/v1/agents/${archived}/transfer`, { toUserId: ids.carol })).status,
    ).toBe(201);
    expect((await as.bob.request("DELETE", `/v1/agents/${archived}`)).status).toBe(200);
    const accept = await as.carol.post(`/v1/agents/${archived}/transfer/accept`);
    expect(accept.status).toBe(409);
    expect(accept.json.code).toBe("agent_archived");
  });

  it("rate-limits transfer and adopt under the roster key (429)", async () => {
    const agent = await personal("bob", "Bob Rate");
    expect((await assign("bob", agent, "team")).status).toBe(201);
    const exhaust = (who: Person) =>
      sql(
        `INSERT INTO rate_limits (key, count, last_request) VALUES ($1, 60, $2)
           ON CONFLICT (key) DO UPDATE SET count = 60, last_request = $2`,
        [`kobe:agent-roster:${ids[who]}`, Date.now()],
      );
    const reset = (who: Person) =>
      sql(`DELETE FROM rate_limits WHERE key = $1`, [`kobe:agent-roster:${ids[who]}`]);
    await exhaust("bob");
    await exhaust("alice");
    try {
      const transfer = await as.bob.post(`/v1/agents/${agent}/transfer`, { toUserId: ids.carol });
      expect(transfer.status).toBe(429);
      const adopt = await as.alice.post(`/v1/team/agent-roster/${agent}/adopt`);
      expect(adopt.status).toBe(429);
    } finally {
      await reset("bob");
      await reset("alice");
    }
  });
});
