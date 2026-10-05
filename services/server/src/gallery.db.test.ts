import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGalleryAgents } from "./gallery/seed.js";
import type { GalleryDefinition } from "./gallery/definitions.js";
import type { TestBrowser, TestResponse } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * The gallery mechanism (KOBE-87): agents seeded from definitions in the repo, read-only through
 * the API for everyone, visible and usable in every team, forked into editable team agents.
 */
type Person = "admin" | "alice" | "bob" | "carol" | "erin";
// Finance: alice team_admin, bob builder, carol member. Marketing: erin builder, carol member.
const PEOPLE: readonly Person[] = ["admin", "alice", "bob", "carol", "erin"];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();
const marketing = randomUUID();
let h: Harness;

const ANY = { "if-match": "*" };
const json = (res: TestResponse) => JSON.stringify(res.json);

const file = (name: string, prompt: string, skills = "[pdf, xlsx]") =>
  `---\nname: ${name}\ndescription: A fixture for the gallery tests\nskills: ${skills}\nstarters: ["Hello"]\n---\n${prompt}\n`;
const FIXTURE: GalleryDefinition = {
  key: "fixture-analyst",
  generation: 1,
  file: file("Fixture Analyst", "You analyse fixtures."),
};

const RACE: GalleryDefinition = {
  key: "fixture-race",
  generation: 1,
  file: file("Fixture Race", "Racing."),
};
const FIXTURE_NEXT: GalleryDefinition = {
  ...FIXTURE,
  generation: 2,
  file: file("Fixture Analyst", "You analyse fixtures, better."),
};

async function activate(who: Person, teamId: string): Promise<void> {
  const res = await as[who].put("/v1/me/teams/active", { teamId });
  expect(res.status, json(res)).toBe(200);
  as[who].team = teamId;
}

const audited = async (action: string, agentId: string) =>
  (
    await h.admin.query<{
      team_id: string | null;
      actor_kind: string;
      target: Record<string, unknown>;
    }>(
      `SELECT team_id, actor_kind, target FROM audit_log WHERE action = $1 AND target->>'agentId' = $2 ORDER BY seq`,
      [action, agentId],
    )
  ).rows;

const versions = async (agentId: string) =>
  (
    await h.admin.query<{ version: number; published_by: string | null }>(
      `SELECT version, published_by FROM install_agent_versions WHERE agent_id = $1 ORDER BY version`,
      [agentId],
    )
  ).rows;

async function seed(...definitions: GalleryDefinition[]) {
  return seedGalleryAgents(h.deps.database.db, definitions);
}

async function galleryId(who: Person = "carol", slug = FIXTURE.key): Promise<string> {
  const list = await as[who].get("/v1/agents?scope=gallery");
  const found = list.json.agents.find((a: { slug: string }) => a.slug === slug);
  expect(found, json(list)).toBeDefined();
  return found.id as string;
}

beforeAll(async () => {
  h = await openHarness();
  ids.admin = await h.createUser("admin@gallery.test", "owner");
  for (const who of PEOPLE.filter((p) => p !== "admin")) {
    ids[who] = await h.createUser(`${who}@gallery.test`);
  }
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance'), ($2, 'marketing', 'Marketing')`,
    [finance, marketing],
  );
  const members: [string, Person, string][] = [
    [finance, "alice", "team_admin"],
    [finance, "bob", "builder"],
    [finance, "carol", "member"],
    [marketing, "erin", "builder"],
    [marketing, "carol", "member"],
  ];
  for (const [team, who, role] of members) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
  }
  for (const who of PEOPLE) as[who] = await h.signIn(`${who}@gallery.test`);
  for (const who of ["alice", "bob", "carol"] as const) await activate(who, finance);
  await activate("erin", marketing);
});

afterAll(async () => {
  await h?.close();
});

describe("seeding from the repo's definitions", () => {
  it("creates a gallery agent with a published v1 and audits it as the system", async () => {
    const [result] = await seed(FIXTURE);
    expect(result).toMatchObject({ key: "fixture-analyst", action: "created" });
    const id = result?.agentId ?? "";
    const one = await as.carol.get(`/v1/agents/${id}`);
    expect(one.json.agent).toMatchObject({
      scope: "gallery",
      slug: "fixture-analyst",
      name: "Fixture Analyst",
      currentVersion: 1,
      ownerUserId: null,
      canEdit: false,
      canPublish: false,
      frontmatter: { skills: ["pdf", "xlsx"] },
    });
    expect(await versions(id)).toEqual([{ version: 1, published_by: null }]);
    const created = await audited("agent.created", id);
    expect(created).toMatchObject([
      { team_id: null, actor_kind: "system", target: { source: "seed" } },
    ]);
    expect((await audited("agent.published", id))[0]?.actor_kind).toBe("system");
  });

  it("is idempotent across restarts: nothing changes when the definitions do not", async () => {
    const id = await galleryId();
    const audits = async () =>
      (await h.admin.query(`SELECT count(*)::int AS n FROM audit_log`)).rows[0].n as number;
    const before = await audits();
    for (let restart = 0; restart < 3; restart++) {
      expect((await seed(FIXTURE))[0]).toMatchObject({ agentId: id, action: "unchanged" });
    }
    expect(await versions(id)).toHaveLength(1);
    expect(await audits()).toBe(before);
    expect((await as.carol.get(`/v1/agents/${id}`)).json.agent.revision).toBe(1);
  });

  it("survives replicas seeding at the same moment", async () => {
    await Promise.all([seed(FIXTURE, RACE), seed(FIXTURE, RACE), seed(FIXTURE, RACE)]);
    const id = await galleryId("carol", "fixture-race");
    expect(await versions(id)).toHaveLength(1);
  });

  it("publishes one new version when a release changes the definition", async () => {
    const id = await galleryId();
    const pinned = await as.carol.post("/v1/threads", { agent_id: id });
    expect(pinned.status, json(pinned)).toBe(201);
    expect((await seed(FIXTURE_NEXT, RACE))[0]).toMatchObject({ agentId: id, action: "updated" });
    expect((await seed(FIXTURE_NEXT, RACE))[0]?.action).toBe("unchanged");
    expect((await versions(id)).map((v) => v.version)).toEqual([1, 2]);
    const one = await as.carol.get(`/v1/agents/${id}`);
    expect(one.json.agent).toMatchObject({
      currentVersion: 2,
      prompt: "You analyse fixtures, better.",
    });
    // A conversation started on v1 keeps v1; new ones get v2.
    const old = await as.carol.get(`/v1/threads/${pinned.json.thread_id}`);
    expect(old.json).toMatchObject({ agent_id: id, agent_version: 1 });
    const fresh = await as.carol.post("/v1/threads", { agent_id: id });
    expect(fresh.json.agent_version).toBe(2);
  });

  it("ignores an older generation: a replica from an older release changes nothing", async () => {
    const id = await galleryId();
    const before = await versions(id);
    expect((await seed(FIXTURE, RACE))[0]).toMatchObject({ agentId: id, action: "unchanged" });
    expect(await versions(id)).toEqual(before);
    expect((await as.carol.get(`/v1/agents/${id}`)).json.agent.prompt).toBe(
      "You analyse fixtures, better.",
    );
  });

  it("skips an archived agent with the same slug and keeps starting, restart after restart", async () => {
    await h.admin.query(
      `INSERT INTO install_agents (scope, slug, frontmatter, prompt, archived_at)
       VALUES ('gallery', 'old-archived', '{"name":"Old"}', 'old', now())`,
    );
    const def = { key: "old-archived", generation: 1, file: file("Old", "New.") };
    for (let restart = 0; restart < 2; restart++) {
      const results = await seed(FIXTURE_NEXT, RACE, def);
      expect(results[2]?.action).toBe("skipped_archived");
      expect(results[0]?.action).toBe("unchanged");
    }
  });

  it("logs a definition that fails and still seeds the others", async () => {
    const bad = { key: "fixture-bad", generation: 1, file: file("Fixture Bad", "Bad.") };
    const good = { key: "fixture-good", generation: 1, file: file("Fixture Good", "Fine.") };
    await h.admin.query(
      `ALTER TABLE install_agents ADD CONSTRAINT tmp_fail CHECK (slug <> 'fixture-bad') NOT VALID`,
    );
    try {
      const results = await seed(FIXTURE_NEXT, RACE, bad, good);
      expect(results.map((r) => r.action)).toEqual(["unchanged", "unchanged", "failed", "created"]);
    } finally {
      await h.admin.query(`ALTER TABLE install_agents DROP CONSTRAINT tmp_fail`);
    }
  });

  it("refuses a broken definition and duplicate keys before touching anything", async () => {
    await expect(seed({ key: "bad", generation: 1, file: "no frontmatter" })).rejects.toThrow(
      /bad.*invalid/,
    );
    await expect(seed({ key: "Not A Slug", generation: 1, file: FIXTURE.file })).rejects.toThrow(
      /slug/,
    );
    await expect(seed(FIXTURE, FIXTURE)).rejects.toThrow(/twice/);
  });

  it("adopts a gallery agent that already has the key as its slug", async () => {
    await h.admin.query(
      `INSERT INTO install_agents (scope, slug, frontmatter, prompt) VALUES ('gallery', 'legacy-one', '{"name":"Legacy"}', 'old')`,
    );
    const [, , result] = await seed(FIXTURE_NEXT, RACE, {
      key: "legacy-one",
      generation: 1,
      file: file("Legacy", "New text."),
    });
    expect(result?.action).toBe("created");
    const id = await galleryId("carol", "legacy-one");
    expect((await as.carol.get(`/v1/agents/${id}`)).json.agent).toMatchObject({
      prompt: "New text.",
      currentVersion: 1,
    });
  });
});

describe("gallery agents are read-only (ac-1)", () => {
  it("answers every write on the install route with 405, install admins included", async () => {
    const id = await galleryId();
    const base = "/v1/install/gallery/agents";
    const body = { frontmatter: { name: "X" }, prompt: "x" };
    for (const who of ["admin", "bob", "carol"] as const) {
      const calls = [
        as[who].post(base, body),
        as[who].put(`${base}/${id}`, body, ANY),
        as[who].delete(`${base}/${id}`),
        as[who].put(`${base}/${id}/status`, { status: "suspended" }),
        as[who].request("POST", `${base}/${id}/publish`, {}, ANY),
        as[who].request("POST", `${base}/${id}/rollback`, { version: 1 }, ANY),
        as[who].post(`${base}/${id}/unarchive`),
      ];
      const results = await Promise.all(calls);
      const want = who === "admin" ? 405 : 403;
      expect(
        results.map((r) => r.status),
        who,
      ).toEqual(results.map(() => want));
    }
    const admin = await as.admin.put(
      `${base}/${id}`,
      { frontmatter: { name: "X" }, prompt: "x" },
      ANY,
    );
    expect(admin.json.code).toBe("gallery_read_only");
  });

  it("lets install admins read the gallery and export", async () => {
    const id = await galleryId();
    const list = await as.admin.get("/v1/install/gallery/agents");
    expect(list.json.agents.map((a: { id: string }) => a.id)).toContain(id);
    expect((await as.admin.get(`/v1/install/gallery/agents/${id}`)).json.agent.canEdit).toBe(false);
    expect((await as.admin.get(`/v1/install/gallery/agents/${id}/export`)).text).toMatch(
      /^---\nname: Fixture Analyst\n/,
    );
  });

  it("refuses every write on /v1/agents to every team role", async () => {
    const id = await galleryId();
    const body = { frontmatter: { name: "X" }, prompt: "x" };
    for (const who of ["alice", "bob", "carol"] as const) {
      const results = await Promise.all([
        as[who].put(`/v1/agents/${id}`, body, ANY),
        as[who].delete(`/v1/agents/${id}`),
        as[who].put(`/v1/agents/${id}/status`, { status: "suspended" }),
        as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY),
        as[who].request("POST", `/v1/agents/${id}/rollback`, { version: 1 }, ANY),
        as[who].post(`/v1/agents/${id}/unarchive`),
      ]);
      expect(
        results.map((r) => r.status),
        who,
      ).toEqual([403, 403, 403, 403, 403, 403]);
    }
    expect((await as.carol.get(`/v1/agents/${id}`)).json.agent.revision).toBeGreaterThan(0);
    expect((await versions(id)).map((v) => v.version)).toEqual([1, 2]);
  });
});

describe("visible and usable in every team", () => {
  it("lists the gallery in every team and starts chats with it", async () => {
    const id = await galleryId();
    for (const who of ["carol", "erin"] as const) {
      const list = await as[who].get("/v1/agents?scope=gallery");
      expect(list.json.agents.map((a: { id: string }) => a.id)).toContain(id);
      const thread = await as[who].post("/v1/threads", { agent_id: id });
      expect(thread.status, json(thread)).toBe(201);
    }
    await activate("carol", marketing);
    expect((await as.carol.get("/v1/agents?scope=gallery")).json.agents.length).toBeGreaterThan(0);
    await activate("carol", finance);
  });

  it("keeps team suspension working: one team's suspension does not reach another", async () => {
    const id = await galleryId();
    const suspend = await as.alice.put(`/v1/agents/inventory/${id}/status`, {
      status: "suspended",
    });
    expect(suspend.status, json(suspend)).toBe(200);
    expect((await as.carol.post("/v1/threads", { agent_id: id })).status).toBe(409);
    expect((await as.erin.post("/v1/threads", { agent_id: id })).status).toBe(201);
    const back = await as.alice.put(`/v1/agents/inventory/${id}/status`, { status: "active" });
    expect(back.status).toBe(200);
    expect((await as.carol.post("/v1/threads", { agent_id: id })).status).toBe(201);
  });
});

describe("fork to team (ac-2)", () => {
  it("copies the published version into an editable team agent, with provenance", async () => {
    const id = await galleryId();
    const res = await as.bob.post(`/v1/agents/${id}/fork`, { scope: "team" });
    expect(res.status, json(res)).toBe(201);
    const fork = res.json.agent;
    expect(fork).toMatchObject({
      scope: "team",
      slug: "fixture-analyst",
      ownerUserId: ids.bob,
      currentVersion: null,
      canEdit: true,
      revision: 1,
      prompt: "You analyse fixtures, better.",
      frontmatter: { name: "Fixture Analyst", skills: ["pdf", "xlsx"] },
      forkedFrom: { agentId: id, version: 2 },
    });
    expect(res.headers.get("etag")).toBe('"1"');
    const created = await audited("agent.created", fork.id);
    expect(created).toMatchObject([
      {
        team_id: finance,
        target: { source: "fork", forkedFrom: id, forkedFromVersion: 2 },
      },
    ]);
    const edited = await as.bob.put(
      `/v1/agents/${fork.id}`,
      { frontmatter: { name: "My Analyst" }, prompt: "Mine." },
      { "if-match": '"1"' },
    );
    expect(edited.status, json(edited)).toBe(200);
    expect(edited.json.agent).toMatchObject({ name: "My Analyst", prompt: "Mine.", revision: 2 });
    const published = await as.bob.request("POST", `/v1/agents/${fork.id}/publish`, {}, ANY);
    expect(published.status, json(published)).toBe(201);
    // The gallery original is untouched.
    expect((await as.carol.get(`/v1/agents/${id}`)).json.agent).toMatchObject({
      name: "Fixture Analyst",
      currentVersion: 2,
    });
    // The fork stays in its team.
    expect((await as.erin.get(`/v1/agents/${fork.id}`)).status).toBe(404);
  });

  it("needs team.agents.build: members and other roles' refusals are 403", async () => {
    const id = await galleryId();
    const member = await as.carol.post(`/v1/agents/${id}/fork`, { scope: "team" });
    expect(member).toMatchObject({ status: 403, json: { code: "forbidden" } });
    const other = await as.erin.post(`/v1/agents/${id}/fork`, { scope: "team" });
    expect(other.status, json(other)).toBe(201);
    expect(other.json.agent.forkedFrom).toMatchObject({ agentId: id });
  });

  it("numbers a second fork's slug instead of colliding", async () => {
    const id = await galleryId();
    const again = await as.bob.post(`/v1/agents/${id}/fork`, { scope: "team" });
    expect(again.json.agent.slug).toBe("fixture-analyst-2");
  });
});

describe("retiring removed definitions", () => {
  it("archives an agent whose definition left the repo, once, keeping threads and forks", async () => {
    const keep = { key: "fixture-keep", generation: 1, file: file("Fixture Keep", "Stays.") };
    const gone = { key: "fixture-gone", generation: 1, file: file("Fixture Gone", "Leaving.") };
    await seed(FIXTURE_NEXT, RACE, keep, gone);
    const id = await galleryId("carol", "fixture-gone");
    const thread = await as.carol.post("/v1/threads", { agent_id: id });
    const fork = await as.bob.post(`/v1/agents/${id}/fork`, { scope: "team" });
    expect(fork.status, json(fork)).toBe(201);

    await seed(FIXTURE_NEXT, RACE, keep);
    const list = await as.carol.get("/v1/agents?scope=gallery");
    const slugs = list.json.agents.map((a: { slug: string }) => a.slug);
    expect(slugs).not.toContain("fixture-gone");
    expect(slugs).toContain("fixture-keep");
    expect((await as.carol.post("/v1/threads", { agent_id: id })).status).toBe(409);
    const old = await as.carol.get(`/v1/threads/${thread.json.thread_id}`);
    expect(old.json).toMatchObject({ agent_id: id, agent_version: 1 });
    expect((await as.bob.get(`/v1/agents/${fork.json.agent.id}`)).status).toBe(200);

    const archived = await audited("agent.archived", id);
    expect(archived).toMatchObject([{ actor_kind: "system", team_id: null }]);
    await seed(FIXTURE_NEXT, RACE, keep);
    expect(await audited("agent.archived", id)).toHaveLength(1);
    // Back in the repo: an archived agent is not revived behind anyone's back.
    expect((await seed(FIXTURE_NEXT, RACE, keep, gone))[3]?.action).toBe("skipped_archived");
  });
});
