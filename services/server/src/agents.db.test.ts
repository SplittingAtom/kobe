import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAgentFile, serializeAgentFile } from "@kobe/agent-file";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { RawBody, TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * Agent definitions over HTTP (KOBE-45): scopes, CRUD, import/export, authorization per role,
 * and cross-team isolation. Own throwaway database (it needs an Owner and fixed teams).
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

const SPEC_EXAMPLE = `---
name: Release Notes Writer
role: Drafts release notes from merged pull requests and Jira tickets
description: Turns a release tag into user-facing notes
model: smart
skills: [docx]
connectors: [github, jira]
tools: { deny: ["bash:rm -rf*"] }
approval_mode: ask-on-write
starters: ["Draft notes for the latest tag"]
---
You write concise, user-facing release notes grouped by feature area…
`;

/** If-Match for edits that aren't about concurrency: overwrite whatever is there. */
const ANY = { "if-match": "*" };
const markdown = (text: string) => new RawBody(text, "text/markdown; charset=utf-8");
const definition = (name: string, prompt = `You are ${name}.`) => ({
  frontmatter: { name, starters: ["Hello"] },
  prompt,
});

type Person = "owner" | "installAdmin" | "alice" | "bob" | "carol" | "dave";
// Finance: alice team_admin, bob builder, carol member, dave builder.
// Marketing: carol member, dave builder.
const PEOPLE: readonly Person[] = ["owner", "installAdmin", "alice", "bob", "carol", "dave"];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();
const marketing = randomUUID();

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;

async function activate(who: Person, teamId: string): Promise<void> {
  const res = await as[who].put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  as[who].team = teamId;
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "t".repeat(48),
    setupToken: "setup-token-for-agent-tests-0123",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const installRole = who === "owner" ? "owner" : who === "installAdmin" ? "admin" : undefined;
    const user = await deps.createUserWithPassword(
      { email: `${who}@agents.test`, name: who, password: PASSWORD },
      installRole ? { installRole } : {},
    );
    ids[who] = user.id;
  }
  const admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  try {
    await admin.query(
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
      await admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
        team,
        ids[who],
        role,
      ]);
    }
  } finally {
    await admin.end();
  }
  for (const who of PEOPLE) {
    const b = new TestBrowser(app, PUBLIC_URL);
    const res = await b.post("/api/auth/sign-in/email", {
      email: `${who}@agents.test`,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    as[who] = b;
  }
  for (const who of ["alice", "bob", "carol", "dave"] as const) await activate(who, finance);
});

afterAll(async () => {
  await deps?.close();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

describe("creating agents (D8, D19)", () => {
  it("lets builders create team agents and refuses members", async () => {
    const res = await as.bob.post("/v1/agents", { scope: "team", ...definition("Report Bot") });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.agent).toMatchObject({
      scope: "team",
      slug: "report-bot",
      name: "Report Bot",
      status: "active",
      ownerUserId: ids.bob,
      currentVersion: null,
      revision: 1,
      canEdit: true,
      frontmatter: { name: "Report Bot", starters: ["Hello"] },
      prompt: "You are Report Bot.",
    });
    expect(res.headers.get("etag")).toBe('"1"');

    const member = await as.carol.post("/v1/agents", { scope: "team", ...definition("Nope") });
    expect(member).toMatchObject({ status: 403, json: { code: "forbidden" } });
  });

  it("lets every member create personal agents", async () => {
    const res = await as.carol.post("/v1/agents", {
      scope: "personal",
      ...definition("Carol Helper"),
    });
    expect(res.status).toBe(201);
    expect(res.json.agent).toMatchObject({ scope: "personal", ownerUserId: ids.carol });
  });

  it("requires X-Kobe-Team on changes (stale-tab guard, D9)", async () => {
    const b = as.bob;
    const team = b.team;
    b.team = undefined;
    try {
      const res = await b.post("/v1/agents", { scope: "personal", ...definition("Headerless") });
      expect(res).toMatchObject({ status: 400, json: { code: "team_header_required" } });
    } finally {
      b.team = team;
    }
  });

  it("derives slugs, suffixes collisions, and refuses an explicit taken slug", async () => {
    const first = await as.bob.post("/v1/agents", { scope: "team", ...definition("Twin") });
    const second = await as.bob.post("/v1/agents", { scope: "team", ...definition("Twin") });
    expect([first.json.agent.slug, second.json.agent.slug]).toEqual(["twin", "twin-2"]);
    const explicit = await as.bob.post("/v1/agents", {
      scope: "team",
      slug: "twin",
      ...definition("Twin"),
    });
    expect(explicit).toMatchObject({ status: 409, json: { code: "slug_taken" } });
    // Slugs are per scope: the same slug is free in personal scope.
    const personal = await as.bob.post("/v1/agents", {
      scope: "personal",
      slug: "twin",
      ...definition("Twin"),
    });
    expect(personal.status).toBe(201);
  });

  it("serializes concurrent creates: distinct auto slugs, no spurious 409", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        as.bob.post("/v1/agents", { scope: "personal", ...definition("Racer") }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.json.agent.slug)).size).toBe(5);
  });

  it("rejects invalid definitions with field-level issues", async () => {
    const res = await as.bob.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Bad", approval_mode: "bypass", extra: 1 },
      prompt: "x",
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_agent");
    expect(res.json.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(["frontmatter.approval_mode", "frontmatter"]),
    );
    for (const body of [
      { scope: "gallery", ...definition("G") },
      { scope: "team", slug: "Bad Slug", ...definition("S") },
      { scope: "team", unknown: true, ...definition("U") },
    ]) {
      expect((await as.bob.post("/v1/agents", body)).status).toBe(400);
    }
  });
});

describe("import and export (§6.3)", () => {
  it("imports the spec example and exports a file that re-imports identically", async () => {
    const created = await as.bob.post("/v1/agents?scope=team", markdown(SPEC_EXAMPLE));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json.agent.slug).toBe("release-notes-writer");
    const id = created.json.agent.id;

    const exported = await as.bob.get(`/v1/agents/${id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toMatch(/^text\/markdown/);
    expect(exported.headers.get("content-disposition")).toBe(
      'attachment; filename="release-notes-writer.md"',
    );
    const original = parseAgentFile(SPEC_EXAMPLE);
    if (!original.ok) throw new Error("spec example must parse");
    expect(exported.text).toBe(serializeAgentFile(original.definition));

    // Re-import the export as a personal agent: same definition.
    const again = await as.bob.post("/v1/agents?scope=personal", markdown(exported.text));
    expect(again.status).toBe(201);
    expect({ frontmatter: again.json.agent.frontmatter, prompt: again.json.agent.prompt }).toEqual(
      original.definition,
    );
  });

  it("replaces a draft from a file with PUT", async () => {
    const created = await as.bob.post("/v1/agents", { scope: "team", ...definition("Reimport") });
    const file = SPEC_EXAMPLE.replace("Release Notes Writer", "Reimported");
    const res = await as.bob.put(`/v1/agents/${created.json.agent.id}`, markdown(file), ANY);
    expect(res.status).toBe(200);
    expect(res.json.agent).toMatchObject({ slug: "reimport", name: "Reimported", revision: 2 });
  });

  it.each([
    ["no frontmatter", "Just a prompt"],
    ["an alias bomb", "---\nname: &a A\nrole: *a\n---\n"],
    ["a custom tag", "---\nname: !js/function x\n---\n"],
    ["unknown keys", "---\nname: A\nsystem: x\n---\n"],
  ])("refuses a file with %s", async (_name, text) => {
    const res = await as.bob.post("/v1/agents?scope=personal", markdown(text));
    expect(res).toMatchObject({ status: 400, json: { code: "invalid_agent" } });
  });

  it("refuses oversized uploads and unknown content types", async () => {
    const huge = `---\nname: Big\n---\n${"x".repeat(600 * 1024)}`;
    expect((await as.bob.post("/v1/agents?scope=personal", markdown(huge))).status).toBe(413);
    const big = `---\nname: Big\n---\n${"x".repeat(200 * 1024)}`;
    expect((await as.bob.post("/v1/agents?scope=personal", markdown(big))).json.code).toBe(
      "invalid_agent",
    );
    const yaml = new RawBody("name: A", "application/yaml");
    expect((await as.bob.post("/v1/agents?scope=personal", yaml)).status).toBe(415);
  });

  it("never lets an import set status, revision or other server fields", async () => {
    const viaQuery = await as.bob.post(
      "/v1/agents?scope=personal&status=suspended&revision=9",
      markdown(SPEC_EXAMPLE),
    );
    expect(viaQuery).toMatchObject({ status: 400, json: { code: "invalid_request" } });
    const viaFrontmatter = await as.bob.post(
      "/v1/agents?scope=personal",
      markdown("---\nname: A\nstatus: suspended\nrevision: 9\n---\n"),
    );
    expect(viaFrontmatter).toMatchObject({ status: 400, json: { code: "invalid_agent" } });
    const viaJson = await as.bob.post("/v1/agents", {
      scope: "personal",
      status: "suspended",
      ...definition("Sneaky"),
    });
    expect(viaJson.status).toBe(400);
  });

  it("answers 400, not 500, for pathologically nested YAML", async () => {
    const deep = `---\nname: A\nrole: ${"[".repeat(5000)}${"]".repeat(5000)}\n---\n`;
    const res = await as.bob.post("/v1/agents?scope=personal", markdown(deep));
    expect(res).toMatchObject({ status: 400, json: { code: "invalid_agent" } });
  });

  it("warns, without blocking, about allow-everything tools and auto approval", async () => {
    const res = await as.bob.post("/v1/agents", {
      scope: "personal",
      frontmatter: { name: "Broad", tools: { allow: ["*"] }, approval_mode: "auto" },
      prompt: "",
    });
    expect(res.status).toBe(201);
    expect(res.json.warnings.map((w: { path: string }) => w.path)).toEqual([
      "frontmatter.tools.allow.0",
      "frontmatter.approval_mode",
    ]);
    const quiet = await as.bob.post("/v1/agents", { scope: "personal", ...definition("Quiet") });
    expect(quiet.json.warnings).toEqual([]);
  });

  it("requires a scope on import", async () => {
    const res = await as.bob.post("/v1/agents", markdown(SPEC_EXAMPLE));
    expect(res).toMatchObject({ status: 400, json: { code: "invalid_request" } });
  });
});

describe("reading, editing and deleting team agents", () => {
  let agentId = "";
  beforeAll(async () => {
    const res = await as.bob.post("/v1/agents", {
      scope: "team",
      ...definition("Shared", "Secret team prompt."),
    });
    agentId = res.json.agent.id;
  });

  it("shows members the summary only; builders see the definition", async () => {
    const list = await as.carol.get("/v1/agents?scope=team");
    const summary = list.json.agents.find((a: { id: string }) => a.id === agentId);
    expect(summary).toMatchObject({ name: "Shared", starters: ["Hello"], canEdit: false });
    expect(summary.prompt).toBeUndefined();

    const one = await as.carol.get(`/v1/agents/${agentId}`);
    expect(one.status).toBe(200);
    expect(one.json.agent.prompt).toBeUndefined();
    expect((await as.carol.get(`/v1/agents/${agentId}/export`)).status).toBe(403);

    const builder = await as.dave.get(`/v1/agents/${agentId}`);
    expect(builder.json.agent).toMatchObject({ prompt: "Secret team prompt.", canEdit: false });
  });

  it("lets the creator and team admins edit; other builders and members can't", async () => {
    const body = definition("Shared", "Edited.");
    expect((await as.carol.put(`/v1/agents/${agentId}`, body)).status).toBe(403);
    expect((await as.dave.put(`/v1/agents/${agentId}`, body)).status).toBe(403);
    const byOwner = await as.bob.put(`/v1/agents/${agentId}`, body, ANY);
    expect(byOwner.json.agent).toMatchObject({ prompt: "Edited.", revision: 2 });
    const byAdmin = await as.alice.put(
      `/v1/agents/${agentId}`,
      definition("Shared", "Admin."),
      ANY,
    );
    expect(byAdmin.json.agent).toMatchObject({ prompt: "Admin.", revision: 3 });
  });

  it("refuses a stale If-Match (412) and accepts the current revision", async () => {
    const stale = await as.bob.put(`/v1/agents/${agentId}`, definition("Shared"), {
      "if-match": '"1"',
    });
    expect(stale).toMatchObject({ status: 412, json: { code: "revision_mismatch" } });
    const current = await as.bob.get(`/v1/agents/${agentId}`);
    const etag = current.headers.get("etag") ?? "";
    const ok = await as.bob.put(`/v1/agents/${agentId}`, definition("Shared", "Fresh."), {
      "if-match": etag,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.agent.revision).toBe(Number(etag.replaceAll('"', "")) + 1);
    const garbage = await as.bob.put(`/v1/agents/${agentId}`, definition("Shared"), {
      "if-match": "nonsense",
    });
    expect(garbage.status).toBe(400);
    // Edits must say which revision they replace (or * to overwrite): no silent lost updates.
    const missing = await as.bob.put(`/v1/agents/${agentId}`, definition("Shared"));
    expect(missing).toMatchObject({ status: 428, json: { code: "if_match_required" } });
  });

  it("refuses slug changes on PUT", async () => {
    const res = await as.bob.put(`/v1/agents/${agentId}`, { slug: "new", ...definition("S") }, ANY);
    expect(res.status).toBe(400);
  });

  it("lets only team admins suspend team agents", async () => {
    const path = `/v1/agents/${agentId}/status`;
    expect((await as.bob.put(path, { status: "suspended" })).status).toBe(403);
    const res = await as.alice.put(path, { status: "suspended" });
    expect(res.json.agent.status).toBe("suspended");
    expect((await as.alice.put(path, { status: "deleted" })).status).toBe(400);
    expect((await as.alice.put(path, { status: "active" })).json.agent.status).toBe("active");
  });

  it("deletes for the creator only (members 403), then 404", async () => {
    const created = await as.bob.post("/v1/agents", { scope: "team", ...definition("Doomed") });
    const path = `/v1/agents/${created.json.agent.id}`;
    expect((await as.carol.delete(path)).status).toBe(403);
    expect((await as.dave.delete(path)).status).toBe(403);
    expect((await as.bob.delete(path)).status).toBe(204);
    expect((await as.bob.get(path)).status).toBe(404);
    expect((await as.bob.delete(path)).status).toBe(404);
  });

  it("answers 404 for malformed and unknown ids", async () => {
    expect((await as.bob.get("/v1/agents/not-a-uuid")).status).toBe(404);
    expect((await as.bob.get(`/v1/agents/${randomUUID()}`)).status).toBe(404);
  });
});

describe("team walls and personal agents (D5, D6, D9)", () => {
  it("never shows a team's agents in another team, even to a member of both", async () => {
    const created = await as.dave.post("/v1/agents", {
      scope: "team",
      ...definition("Finance Only"),
    });
    const id = created.json.agent.id;
    await activate("dave", marketing);
    try {
      const list = await as.dave.get("/v1/agents");
      expect(list.json.agents.map((a: { id: string }) => a.id)).not.toContain(id);
      expect((await as.dave.get(`/v1/agents/${id}`)).status).toBe(404);
      expect((await as.dave.get(`/v1/agents/${id}/export`)).status).toBe(404);
      expect((await as.dave.put(`/v1/agents/${id}`, definition("Hijack"))).status).toBe(404);
      expect((await as.dave.delete(`/v1/agents/${id}`)).status).toBe(404);
      expect((await as.dave.post(`/v1/agents/${id}/fork`, { scope: "team" })).status).toBe(404);
    } finally {
      await activate("dave", finance);
    }
    // A stale tab still pointing at the other team is refused before any agent lookup.
    const stale = await as.dave.request("DELETE", `/v1/agents/${id}`, undefined, {
      "x-kobe-team": marketing,
    });
    expect(stale).toMatchObject({ status: 409, json: { code: "team_mismatch" } });
  });

  it("keeps personal agents private to their owner and follows them across teams", async () => {
    const created = await as.carol.post("/v1/agents", {
      scope: "personal",
      ...definition("Carol Private", "Carol's prompt."),
    });
    const id = created.json.agent.id;
    expect((await as.bob.get(`/v1/agents/${id}`)).status).toBe(404);
    expect((await as.alice.put(`/v1/agents/${id}`, definition("Taken"))).status).toBe(404);
    expect((await as.alice.delete(`/v1/agents/${id}`)).status).toBe(404);
    const bobs = await as.bob.get("/v1/agents?scope=personal");
    expect(bobs.json.agents.every((a: { ownerUserId: string }) => a.ownerUserId === ids.bob)).toBe(
      true,
    );

    await activate("carol", marketing);
    try {
      const mine = await as.carol.get(`/v1/agents/${id}`);
      expect(mine.json.agent).toMatchObject({ prompt: "Carol's prompt.", canEdit: true });
      expect((await as.carol.put(`/v1/agents/${id}`, definition("Carol Moved"), ANY)).status).toBe(
        200,
      );
    } finally {
      await activate("carol", finance);
    }
  });

  it("refuses team routes to install admins who aren't members", async () => {
    expect((await as.installAdmin.get("/v1/agents")).json.code).toBe("no_active_team");
  });
});

describe("gallery (D19, D21)", () => {
  let galleryId = "";

  it("is seeded from the repo and curated by nobody through the API", async () => {
    const [seeded] = await seedGalleryAgents(deps.database.db, [
      { key: "release-notes-writer", file: SPEC_EXAMPLE },
    ]);
    galleryId = seeded?.agentId ?? "";
    const plain = await as.bob.post("/v1/install/gallery/agents", definition("Rogue"));
    expect(plain.status).toBe(403);
    const res = await as.installAdmin.post("/v1/install/gallery/agents", markdown(SPEC_EXAMPLE));
    expect(res.status).toBe(405);
    const list = await as.owner.get("/v1/install/gallery/agents");
    expect(list.json.agents.map((a: { id: string }) => a.id)).toContain(galleryId);
    const exported = await as.installAdmin.get(`/v1/install/gallery/agents/${galleryId}/export`);
    expect(exported.text).toMatch(/^---\nname: Release Notes Writer\n/);
  });

  it("refuses gallery reads and writes to non-admins on the install route", async () => {
    const base = `/v1/install/gallery/agents/${galleryId}`;
    for (const who of ["alice", "bob", "carol"] as const) {
      expect((await as[who].put(base, definition("X"), ANY)).status).toBe(403);
      expect((await as[who].delete(base)).status).toBe(403);
      expect((await as[who].put(`${base}/status`, { status: "suspended" })).status).toBe(403);
      expect((await as[who].get(base)).status).toBe(403);
    }
  });

  it("is read-only to every team member", async () => {
    const list = await as.carol.get("/v1/agents?scope=gallery");
    expect(list.json.agents.map((a: { id: string }) => a.id)).toContain(galleryId);
    const one = await as.carol.get(`/v1/agents/${galleryId}`);
    expect(one.json.agent).toMatchObject({ scope: "gallery", canEdit: false });
    expect(one.json.agent.prompt).toMatch(/release notes/);
    expect((await as.carol.get(`/v1/agents/${galleryId}/export`)).status).toBe(200);
    expect((await as.alice.put(`/v1/agents/${galleryId}`, definition("X"))).status).toBe(403);
    expect((await as.alice.delete(`/v1/agents/${galleryId}`)).status).toBe(403);
    expect(
      (await as.alice.put(`/v1/agents/${galleryId}/status`, { status: "suspended" })).status,
    ).toBe(403);
  });

  it("forks into personal scope for members and into the team for builders", async () => {
    const path = `/v1/agents/${galleryId}/fork`;
    const personal = await as.carol.post(path, { scope: "personal" });
    expect(personal.status).toBe(201);
    expect(personal.json.agent).toMatchObject({
      scope: "personal",
      slug: "release-notes-writer",
      ownerUserId: ids.carol,
      name: "Release Notes Writer",
    });
    expect((await as.carol.post(path, { scope: "team" })).status).toBe(403);
    const team = await as.bob.post(path, { scope: "team", slug: "notes" });
    expect(team.json.agent).toMatchObject({ scope: "team", slug: "notes", ownerUserId: ids.bob });
  });

  it("never forks a team agent into personal scope", async () => {
    const created = await as.bob.post("/v1/agents", { scope: "team", ...definition("Walled") });
    const res = await as.bob.post(`/v1/agents/${created.json.agent.id}/fork`, {
      scope: "personal",
    });
    expect(res.status).toBe(403);
  });
});
