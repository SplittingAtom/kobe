import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { seedGalleryAgents } from "./gallery/seed.js";
import { resolveAgentPin, resolvePinnedAgent } from "./agents/versions.js";
import { toolManifestSchema } from "./agents/manifest.js";
import type { TestBrowser, TestResponse } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * Agent versions over HTTP (KOBE-46, spec D19, U8, Gate 3): publish with a frozen tool manifest,
 * version history, rollback, archive instead of delete, thread pinning ("v2 publish leaves v1
 * threads pinned and rollback works"), the one-click switch, authorization per role, and team
 * walls.
 */
type Person = "admin" | "alice" | "bob" | "carol" | "dave";
// Finance: alice team_admin, bob builder, carol member, dave builder. Marketing: carol, dave.
const PEOPLE: readonly Person[] = ["admin", "alice", "bob", "carol", "dave"];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();
const marketing = randomUUID();
let h: Harness;

const ANY = { "if-match": "*" };
const definition = (name: string, prompt = `You are ${name}.`, extra: object = {}) => ({
  frontmatter: { name, ...extra },
  prompt,
});

async function activate(who: Person, teamId: string): Promise<void> {
  const res = await as[who].put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  as[who].team = teamId;
}

beforeAll(async () => {
  // Generous publish rate here; the limits have their own suite below.
  h = await openHarness({ agents: { publishRate: { windowMs: 60_000, max: 10_000 } } });
  ids.admin = await h.createUser("admin@versions.test", "owner");
  for (const who of PEOPLE.filter((p) => p !== "admin")) {
    ids[who] = await h.createUser(`${who}@versions.test`);
  }
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance'), ($2, 'marketing', 'Marketing')`,
    [finance, marketing],
  );
  const members: [string, Person, string][] = [
    [finance, "alice", "team_admin"],
    [finance, "bob", "builder"],
    [finance, "carol", "member"],
    [finance, "dave", "builder"],
    [marketing, "carol", "member"],
    [marketing, "dave", "builder"],
  ];
  for (const [team, who, role] of members) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
  }
  for (const who of PEOPLE) as[who] = await h.signIn(`${who}@versions.test`);
  for (const who of ["alice", "bob", "carol", "dave"] as const) await activate(who, finance);
});

afterAll(async () => {
  await h?.close();
});

const json = (res: TestResponse) => JSON.stringify(res.json);

async function create(who: Person, scope: "team" | "personal", name: string, extra: object = {}) {
  const res = await as[who].post("/v1/agents", { scope, ...definition(name, undefined, extra) });
  expect(res.status, json(res)).toBe(201);
  return res.json.agent.id as string;
}

const publish = (
  who: Person,
  id: string,
  ifMatch: Record<string, string> = ANY,
  base = "/v1/agents",
) => as[who].request("POST", `${base}/${id}/publish`, {}, ifMatch);

async function published(who: Person, id: string, base = "/v1/agents") {
  const res = await publish(who, id, ANY, base);
  expect(res.status, json(res)).toBe(201);
  return res.json as { agent: { currentVersion: number }; version: Record<string, unknown> };
}

const edit = (who: Person, id: string, prompt: string) =>
  as[who].put(`/v1/agents/${id}`, definition("Edited", prompt), ANY);

/** Changes the draft, then publishes it (identical republishes are refused as `unchanged`). */
async function republish(who: Person, id: string) {
  expect((await edit(who, id, `revision ${randomUUID()}`)).status).toBe(200);
  return published(who, id);
}

async function newThread(who: Person, agentId: string | null) {
  const res = await as[who].post("/v1/threads", { agent_id: agentId });
  expect(res.status, json(res)).toBe(201);
  return res.json as { thread_id: string; agent_id: string | null; agent_version: number | null };
}

async function audited(action: string, agentId: string) {
  const { rows } = await h.admin.query<{ team_id: string | null; target: Record<string, unknown> }>(
    `SELECT team_id, target FROM audit_log WHERE action = $1 AND target->>'agentId' = $2 ORDER BY seq`,
    [action, agentId],
  );
  return rows;
}

describe("publish (D19, D8)", () => {
  it("lets a builder publish their team agent: v1 with a frozen manifest, audited", async () => {
    const id = await create("bob", "team", "Analyst");
    const res = await publish("bob", id, { "if-match": '"1"' });
    expect(res.status, json(res)).toBe(201);
    expect(res.json.agent).toMatchObject({ currentVersion: 1, revision: 1, archivedAt: null });
    expect(res.json.version).toMatchObject({
      version: 1,
      publishedBy: ids.bob,
      draftRevision: 1,
      republishedFrom: null,
      prompt: "You are Analyst.",
      frontmatter: { name: "Analyst" },
    });
    const manifest = toolManifestSchema.parse(res.json.version.toolManifest);
    expect(manifest).toMatchObject({ floor: "team", approval_mode: { effective: "ask-on-write" } });
    expect(manifest.tools.map((t) => t.name)).toContain("bash");
    expect(await audited("agent.published", id)).toEqual([
      {
        team_id: finance,
        target: { agentId: id, scope: "team", slug: "analyst", version: 1, draftRevision: 1 },
      },
    ]);
  });

  it("requires If-Match and refuses a stale one (nobody publishes changes they haven't seen)", async () => {
    const id = await create("bob", "team", "Careful");
    expect((await publish("bob", id, {})).status).toBe(428);
    await edit("bob", id, "changed");
    const stale = await publish("bob", id, { "if-match": '"1"' });
    expect(stale.status).toBe(412);
    expect(stale.json.code).toBe("revision_mismatch");
    expect((await publish("bob", id, { "if-match": '"2"' })).status).toBe(201);
  });

  it("refuses members and builders who don't own the agent; team admins publish any", async () => {
    const id = await create("bob", "team", "Owned");
    expect((await publish("carol", id)).status).toBe(403);
    expect((await publish("dave", id)).status).toBe(403);
    expect((await publish("alice", id)).status).toBe(201);
  });

  it("lets any member publish their own personal agent, against the install floor", async () => {
    const id = await create("carol", "personal", "Mine");
    const res = await published("carol", id);
    expect(toolManifestSchema.parse(res.version.toolManifest).floor).toBe("install");
    expect((await audited("agent.published", id))[0]?.team_id).toBeNull();
    expect((await publish("dave", id)).status).toBe(404);
  });

  it("publishes gallery agents only by seeding them from the repo", async () => {
    const [seeded] = await seedGalleryAgents(h.deps.database.db, [
      { key: "gallery-helper", file: "---\nname: Gallery Helper\n---\nHelp.\n" },
    ]);
    const id = seeded?.agentId ?? "";
    expect((await publish("alice", id)).status).toBe(403);
    expect((await publish("admin", id, ANY, "/v1/install/gallery/agents")).status).toBe(405);
    const one = await as.carol.get(`/v1/agents/${id}`);
    expect(one.json.agent.currentVersion).toBe(1);
  });

  it("serializes concurrent publishes and rollbacks: distinct consecutive versions", async () => {
    const id = await create("bob", "team", "Busy");
    await published("bob", id);
    await republish("bob", id);
    await republish("bob", id);
    await edit("bob", id, "draft D");
    // Three different contents, none equal to the current one in any order: all succeed.
    const mixed = await Promise.all([
      publish("bob", id),
      as.bob.post(`/v1/agents/${id}/rollback`, { version: 1 }),
      as.bob.post(`/v1/agents/${id}/rollback`, { version: 2 }),
    ]);
    expect(mixed.map((r) => r.status)).toEqual([201, 201, 201]);
    const versions = mixed.map((r) => r.json.version.version as number).sort((a, b) => a - b);
    expect(versions).toEqual([4, 5, 6]);

    // The same draft published five times at once: one version, the rest are no-ops.
    await edit("bob", id, "draft E");
    const same = await Promise.all(Array.from({ length: 5 }, () => publish("bob", id)));
    expect(same.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(same.filter((r) => r.status === 409).map((r) => r.json.code)).toEqual(
      Array(4).fill("unchanged"),
    );
    expect((await as.bob.get(`/v1/agents/${id}`)).json.agent.currentVersion).toBe(7);
  });

  it("refuses to publish a draft identical to the current version", async () => {
    const id = await create("bob", "team", "Same");
    await published("bob", id);
    const again = await publish("bob", id);
    expect(again).toMatchObject({ status: 409, json: { code: "unchanged" } });
  });
});

describe("version history (§6.1 /v1/agents/{id}/versions)", () => {
  it("keeps published versions immutable while the draft moves on", async () => {
    const id = await create("bob", "team", "Frozen");
    await published("bob", id);
    await edit("bob", id, "draft two");
    const v1 = await as.bob.get(`/v1/agents/${id}/versions/1`);
    expect(v1.json.version.prompt).toBe("You are Frozen.");
    await published("bob", id);
    const v2 = await as.bob.get(`/v1/agents/${id}/versions/2`);
    expect(v2.json.version).toMatchObject({ prompt: "draft two", draftRevision: 2 });
    expect((await as.bob.get(`/v1/agents/${id}/versions/1`)).json.version.prompt).toBe(
      "You are Frozen.",
    );
  });

  it("lists versions newest first with paging; members see history but not definitions", async () => {
    const id = await create("bob", "team", "Paged");
    await published("bob", id);
    await republish("bob", id);
    await republish("bob", id);
    const first = await as.carol.get(`/v1/agents/${id}/versions?limit=2`);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ currentVersion: 3, nextBefore: 2 });
    expect(first.json.versions.map((v: { version: number }) => v.version)).toEqual([3, 2]);
    expect(first.json.versions[0].prompt).toBeUndefined();
    const rest = await as.carol.get(`/v1/agents/${id}/versions?before=2&limit=2`);
    expect(rest.json.versions.map((v: { version: number }) => v.version)).toEqual([1]);
    expect(rest.json.nextBefore).toBeNull();
    expect((await as.carol.get(`/v1/agents/${id}/versions/1`)).status).toBe(403);
    expect((await as.bob.get(`/v1/agents/${id}/versions/9`)).json.code).toBe("version_not_found");
    expect((await as.bob.get(`/v1/agents/${id}/versions/0`)).status).toBe(400);
    expect((await as.bob.get(`/v1/agents/${id}/versions?limit=0`)).status).toBe(400);
  });

  it("is invisible from another team, even to someone in both", async () => {
    const id = await create("dave", "team", "Walled");
    await published("dave", id);
    await activate("dave", marketing);
    try {
      expect((await as.dave.get(`/v1/agents/${id}/versions`)).status).toBe(404);
      expect((await as.dave.get(`/v1/agents/${id}/versions/1`)).status).toBe(404);
      expect((await publish("dave", id)).status).toBe(404);
      expect((await as.dave.post(`/v1/agents/${id}/rollback`, { version: 1 })).status).toBe(404);
    } finally {
      await activate("dave", finance);
    }
  });
});

describe("rollback (D19: republishes an older version)", () => {
  it("republishes v1's content as v3 and leaves the draft alone", async () => {
    const id = await create("bob", "team", "Rollback");
    await published("bob", id);
    await edit("bob", id, "broken v2");
    await published("bob", id);
    const res = await as.bob.post(`/v1/agents/${id}/rollback`, { version: 1 });
    expect(res.status, json(res)).toBe(201);
    expect(res.json.version).toMatchObject({
      version: 3,
      republishedFrom: 1,
      draftRevision: null,
      prompt: "You are Rollback.",
    });
    expect(res.json.agent).toMatchObject({ currentVersion: 3, prompt: "broken v2" });
    expect((await audited("agent.rolled_back", id))[0]?.target).toMatchObject({
      version: 3,
      fromVersion: 1,
    });
  });

  it("refuses the current version, unknown versions, bad bodies and members", async () => {
    const id = await create("bob", "team", "Rollback Edge");
    await published("bob", id);
    expect((await as.bob.post(`/v1/agents/${id}/rollback`, { version: 1 })).json.code).toBe(
      "already_current",
    );
    expect((await as.bob.post(`/v1/agents/${id}/rollback`, { version: 7 })).status).toBe(404);
    expect((await as.bob.post(`/v1/agents/${id}/rollback`, { version: "1" })).status).toBe(400);
    expect((await as.carol.post(`/v1/agents/${id}/rollback`, { version: 1 })).status).toBe(403);
  });
});

describe("archive instead of delete (KOBE-45 decision 6)", () => {
  it("still deletes an agent that was never published", async () => {
    const id = await create("bob", "team", "Draft Only");
    expect((await as.bob.delete(`/v1/agents/${id}`)).status).toBe(204);
    expect((await as.bob.get(`/v1/agents/${id}`)).status).toBe(404);
  });

  it("archives a published agent: hidden, read-only, unpinnable; pinned threads keep it", async () => {
    const id = await create("bob", "team", "Retired");
    await published("bob", id);
    const thread = await newThread("carol", id);
    const res = await as.bob.delete(`/v1/agents/${id}`);
    expect(res.status, json(res)).toBe(200);
    expect(res.json.agent.archivedAt).not.toBeNull();
    expect(await audited("agent.archived", id)).toHaveLength(1);
    // Again: no-op.
    expect((await as.bob.delete(`/v1/agents/${id}`)).status).toBe(200);
    expect(await audited("agent.archived", id)).toHaveLength(1);

    const listed = (await as.bob.get("/v1/agents?scope=team")).json.agents.map(
      (a: { id: string }) => a.id,
    );
    expect(listed).not.toContain(id);
    const all = (await as.bob.get("/v1/agents?scope=team&include_archived=true")).json.agents;
    expect(all.map((a: { id: string }) => a.id)).toContain(id);
    expect((await edit("bob", id, "nope")).json.code).toBe("agent_archived");
    expect((await publish("bob", id)).json.code).toBe("agent_archived");
    expect((await as.carol.post("/v1/threads", { agent_id: id })).json.code).toBe(
      "agent_unavailable",
    );
    const pinned = await as.carol.get(`/v1/threads/${thread.thread_id}`);
    expect(pinned.json).toMatchObject({ agent_id: id, agent_version: 1 });

    expect((await as.carol.post(`/v1/agents/${id}/unarchive`)).status).toBe(403);
    const back = await as.bob.post(`/v1/agents/${id}/unarchive`);
    expect(back.status).toBe(200);
    expect(back.json.agent.archivedAt).toBeNull();
    expect(await audited("agent.unarchived", id)).toHaveLength(1);
    expect((await edit("bob", id, "back in service")).status).toBe(200);
    expect((await publish("bob", id)).status).toBe(201);
  });

  it("refuses new threads with an archived gallery agent", async () => {
    const [seeded] = await seedGalleryAgents(h.deps.database.db, [
      { key: "old-gallery", file: "---\nname: Old Gallery\n---\nOld.\n" },
    ]);
    const id = seeded?.agentId ?? "";
    await h.admin.query(`UPDATE install_agents SET archived_at = now() WHERE id = $1`, [id]);
    expect((await as.carol.post("/v1/threads", { agent_id: id })).status).toBe(409);
  });
});

describe("threads pin the version they started on (D19, U8, Gate 3)", () => {
  it("v2 publish leaves v1 threads pinned, badges v2, and rollback works", async () => {
    const id = await create("bob", "team", "Pinned");
    await published("bob", id);
    const t1 = await newThread("carol", id);
    expect(t1).toMatchObject({ agent_id: id, agent_version: 1 });

    await edit("bob", id, "v2 prompt");
    await published("bob", id);
    const read = await as.carol.get(`/v1/threads/${t1.thread_id}`);
    expect(read.json).toMatchObject({ agent_version: 1, agent_current_version: 2 });
    const t2 = await newThread("carol", id);
    expect(t2.agent_version).toBe(2);

    const rolled = await as.bob.post(`/v1/agents/${id}/rollback`, { version: 1 });
    expect(rolled.json.version.version).toBe(3);
    expect((await as.carol.get(`/v1/threads/${t1.thread_id}`)).json.agent_version).toBe(1);
    expect((await as.carol.get(`/v1/threads/${t2.thread_id}`)).json.agent_version).toBe(2);
    expect((await newThread("carol", id)).agent_version).toBe(3);

    // The run-time seam resolves exactly the pinned version, never a newer one.
    const pin = await withTeam(h.deps.database.db, finance, (tx) =>
      resolvePinnedAgent(
        tx,
        { teamId: finance, userId: ids.carol },
        { agentScope: "team", agentId: id, agentVersion: 1 },
      ),
    );
    expect(pin.ok && pin.version.definition.prompt).toBe("You are Pinned.");
  });

  it("switches a thread to the current version in one click, or to a chosen one", async () => {
    const id = await create("bob", "team", "Switchy");
    await published("bob", id);
    const t = await newThread("carol", id);
    await republish("bob", id);
    const res = await as.carol.post(`/v1/threads/${t.thread_id}/agent-version`, {});
    expect(res.status, json(res)).toBe(200);
    expect(res.json.agent_version).toBe(2);
    const audit = await h.admin.query(
      `SELECT team_id, target FROM audit_log WHERE action = 'thread.agent_switched' AND target->>'threadId' = $1`,
      [t.thread_id],
    );
    expect(audit.rows).toEqual([
      {
        team_id: finance,
        target: { threadId: t.thread_id, agentId: id, scope: "team", fromVersion: 1, toVersion: 2 },
      },
    ]);
    const back = await as.carol.post(`/v1/threads/${t.thread_id}/agent-version`, { version: 1 });
    expect(back.json.agent_version).toBe(1);
    const missing = await as.carol.post(`/v1/threads/${t.thread_id}/agent-version`, {
      version: 9,
    });
    expect(missing).toMatchObject({ status: 404, json: { code: "version_not_found" } });
    // Not the owner: the thread doesn't exist for them.
    expect((await as.bob.post(`/v1/threads/${t.thread_id}/agent-version`, {})).status).toBe(404);
  });

  it("refuses to switch while a run is active, without an agent, or a suspended agent", async () => {
    const id = await create("bob", "team", "Guarded");
    await published("bob", id);
    const t = await newThread("carol", id);
    await republish("bob", id);
    const run = randomUUID();
    await h.admin.query(
      `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at) VALUES ($1, $2, $3, 'user', 'running', now())`,
      [finance, run, t.thread_id],
    );
    const busy = await as.carol.post(`/v1/threads/${t.thread_id}/agent-version`, {});
    expect(busy.json.code).toBe("thread_busy");
    await h.admin.query(`UPDATE runs SET status = 'completed', ended_at = now() WHERE id = $1`, [
      run,
    ]);

    const plain = await newThread("carol", null);
    expect(
      (await as.carol.post(`/v1/threads/${plain.thread_id}/agent-version`, {})).json.code,
    ).toBe("no_agent");

    expect((await as.alice.put(`/v1/agents/${id}/status`, { status: "suspended" })).status).toBe(
      200,
    );
    const suspended = await as.carol.post(`/v1/threads/${t.thread_id}/agent-version`, {});
    expect(suspended.json.code).toBe("agent_unavailable");
    expect((await as.carol.post("/v1/threads", { agent_id: id })).json.code).toBe(
      "agent_unavailable",
    );
    const seam = await withTeam(h.deps.database.db, finance, (tx) =>
      resolvePinnedAgent(
        tx,
        { teamId: finance, userId: ids.carol },
        { agentScope: "team", agentId: id, agentVersion: 1 },
      ),
    );
    expect(seam).toEqual({ ok: false, error: "agent_suspended" });
  });

  it("holds the agent row while pinning, so a suspend can't slip in before the pin (L1)", async () => {
    // FOR SHARE, not FOR KEY SHARE: suspend, archive and publish are non-key UPDATEs (FOR NO KEY
    // UPDATE), which conflict with FOR SHARE but not with FOR KEY SHARE.
    const id = await create("bob", "team", "Raced");
    await published("bob", id);
    await withTeam(h.deps.database.db, finance, async (tx) => {
      const pin = await resolveAgentPin(tx, { teamId: finance, userId: ids.carol }, id);
      expect(pin.ok).toBe(true);
      const suspend = h.admin.query(
        `BEGIN; SET LOCAL lock_timeout = '300ms';
         UPDATE team_agents SET status = 'suspended' WHERE id = '${id}'; COMMIT;`,
      );
      const err = await suspend.then(
        () => undefined,
        (e: unknown) => e as { code?: string },
      );
      await h.admin.query("ROLLBACK");
      expect(err?.code).toBe("55P03");
    });
  });

  it("pins only agents the caller can use from the active team", async () => {
    const draft = await create("bob", "team", "Unpublished");
    expect((await as.carol.post("/v1/threads", { agent_id: draft })).json.code).toBe(
      "agent_unavailable",
    );
    const carols = await create("carol", "personal", "Carol Only");
    await published("carol", carols);
    expect((await newThread("carol", carols)).agent_version).toBe(1);
    expect((await as.dave.post("/v1/threads", { agent_id: carols })).status).toBe(404);

    const team = await create("dave", "team", "Finance Only");
    await published("dave", team);
    await activate("carol", marketing);
    try {
      // Same user, other team: the finance agent doesn't exist there; her personal agent does.
      expect((await as.carol.post("/v1/threads", { agent_id: team })).status).toBe(404);
      expect((await newThread("carol", carols)).agent_version).toBe(1);
    } finally {
      await activate("carol", finance);
    }

    // A gallery row nobody published (only by hand in the database) can't start threads.
    const unpublished = await h.admin.query<{ id: string }>(
      `INSERT INTO install_agents (scope, slug, frontmatter, prompt)
       VALUES ('gallery', 'unpublished', '{"name":"Unpublished"}', 'x') RETURNING id`,
    );
    expect((await as.carol.post("/v1/threads", { agent_id: unpublished.rows[0]?.id })).status).toBe(
      409,
    );
    const [seeded] = await seedGalleryAgents(h.deps.database.db, [
      { key: "shared", file: "---\nname: Shared\n---\nShared.\n" },
    ]);
    expect((await newThread("carol", seeded?.agentId ?? "")).agent_version).toBe(1);
  });
});

describe("frozen manifest against the floor (D6, D19, D29)", () => {
  it("excludes floor-denied tools at publish; a later floor change never edits a version", async () => {
    const install = await as.admin.post("/v1/install/policy/rules", {
      effect: "deny",
      tool_glob: "bash",
    });
    expect(install.status, json(install)).toBe(201);
    const team = await as.alice.post("/v1/team/policy/rules", {
      effect: "deny",
      tool_glob: "powershell",
    });
    expect(team.status, json(team)).toBe(201);
    await h.admin.query(
      `INSERT INTO install_settings (key, value) VALUES ('policy.approval_floor', 'ask-on-write')`,
    );
    try {
      const teamAgent = await create("bob", "team", "Floored", { approval_mode: "auto" });
      const v1 = toolManifestSchema.parse((await published("bob", teamAgent)).version.toolManifest);
      const names = v1.tools.map((t) => t.name);
      expect(names).not.toContain("bash");
      expect(names).not.toContain("powershell");
      expect(v1.excluded).toContainEqual({
        name: "bash",
        reason: "install_deny_rule",
        rule_id: install.json.rule.id,
      });
      expect(v1.excluded).toContainEqual({
        name: "powershell",
        reason: "team_deny_rule",
        rule_id: team.json.rule.id,
      });
      expect(v1.approval_mode).toEqual({
        requested: "auto",
        floor: "ask-on-write",
        effective: "ask-on-write",
      });

      // Personal agents follow the user into other teams: only the install floor freezes them.
      const personal = await create("bob", "personal", "Portable");
      const p1 = toolManifestSchema.parse((await published("bob", personal)).version.toolManifest);
      expect(p1.tools.map((t) => t.name)).toContain("powershell");
      expect(p1.tools.map((t) => t.name)).not.toContain("bash");

      // The floor loosens: v1 stays as published; a republish picks the change up.
      expect(
        (await as.admin.delete(`/v1/install/policy/rules/${install.json.rule.id}`)).status,
      ).toBe(204);
      const again = await as.bob.get(`/v1/agents/${teamAgent}/versions/1`);
      expect(again.json.version.toolManifest).toEqual(v1);
      const v2 = toolManifestSchema.parse((await published("bob", teamAgent)).version.toolManifest);
      expect(v2.tools.map((t) => t.name)).toContain("bash");
    } finally {
      await h.admin.query(`DELETE FROM install_settings WHERE key = 'policy.approval_floor'`);
      await h.admin.query(`DELETE FROM install_tool_rules`);
      await h.admin.query(`DELETE FROM tool_rules`);
    }
  });
});

describe("a version whose manifest can't be read (fail closed)", () => {
  it("answers version_unreadable over HTTP and to the run-time seam", async () => {
    const id = await create("bob", "team", "Corrupt");
    await published("bob", id);
    // Manual SQL (or a future format): inserts are allowed, the trigger only stops changes.
    await h.admin.query(
      `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt, tool_manifest, published_by, draft_revision)
       VALUES ($1, $2, 2, '{"name":"Corrupt"}', 'x', '{"format":99}', $3, 1)`,
      [finance, id, ids.bob],
    );
    const res = await as.bob.get(`/v1/agents/${id}/versions/2`);
    expect(res).toMatchObject({ status: 500, json: { code: "version_unreadable" } });
    const rollback = await as.bob.post(`/v1/agents/${id}/rollback`, { version: 2 });
    expect(rollback.json.code).toBe("version_unreadable");
    const seam = await withTeam(h.deps.database.db, finance, (tx) =>
      resolvePinnedAgent(
        tx,
        { teamId: finance, userId: ids.bob },
        { agentScope: "team", agentId: id, agentVersion: 2 },
      ),
    );
    expect(seam).toEqual({ ok: false, error: "version_unreadable" });
  });
});

describe("forks of gallery agents", () => {
  it("copy the published version, not the curators' draft in progress", async () => {
    const [seeded] = await seedGalleryAgents(h.deps.database.db, [
      { key: "curated", file: "---\nname: Curated\n---\nPublished prompt.\n" },
    ]);
    const id = seeded?.agentId ?? "";
    // A draft in progress (set by hand: nothing in the API edits gallery drafts any more).
    await h.admin.query(`UPDATE install_agents SET prompt = 'Work in progress.' WHERE id = $1`, [
      id,
    ]);
    const fork = await as.carol.post(`/v1/agents/${id}/fork`, { scope: "personal" });
    expect(fork.status, json(fork)).toBe(201);
    expect(fork.json.agent.prompt).toBe("Published prompt.");
  });
});
