import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";
import { findThread, updateThread } from "./threads/repository.js";
import {
  entryPageSchema,
  threadDetailSchema,
  threadEntrySchema,
  threadPageSchema,
  threadSearchPageSchema,
  threadSummarySchema,
} from "./threads/schemas.js";

// KOBE-34 Thread API against a real Postgres: own throwaway database (it needs an Owner).
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

const PEOPLE = ["owner", "installAdmin", "alice", "bob", "carol", "dave", "erin"] as const;
type Person = (typeof PEOPLE)[number];
const ids = Object.fromEntries(PEOPLE.map((p) => [p, ""])) as Record<Person, string>;
const email = (who: Person) => `${who.toLowerCase()}@threads.test`;

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;
let admin: pg.Client;
let as: Record<Person, TestBrowser>;
// finance: alice team_admin, bob member, carol builder. marketing: dave team_admin, bob member.
let finance = "";
let marketing = "";

async function signIn(who: Person): Promise<TestBrowser> {
  const b = new TestBrowser(app, PUBLIC_URL);
  const res = await b.post("/api/auth/sign-in/email", { email: email(who), password: PASSWORD });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return b;
}

async function activate(b: TestBrowser, teamId: string): Promise<void> {
  const res = await b.put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  b.team = teamId;
}

/** Adds an existing user through a team invitation they accept (KOBE-13). */
async function addMember(by: TestBrowser, who: Person, role: string): Promise<void> {
  const res = await by.post("/v1/team/invites", { email: email(who), role });
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  const accepted = await as[who].post(`/v1/me/invites/${by.team}/accept`);
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
}

async function newThread(b: TestBrowser, body: object = {}): Promise<string> {
  const res = await b.post("/v1/threads", body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.thread_id as string;
}

/** Appends Pi entries as the database owner would (writers arrive with KOBE-30/23). */
async function appendEntries(
  teamId: string,
  threadId: string,
  entries: readonly { id: string; parent: string | null; type?: string; blob?: boolean }[],
): Promise<void> {
  for (const e of entries) {
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        teamId,
        threadId,
        e.id,
        e.parent,
        e.type ?? "message",
        JSON.stringify(e.blob ? {} : { message: { role: "user", content: `text ${e.id}` } }),
        e.blob ? `blobs/${e.id}` : null,
      ],
    );
  }
}

async function addRun(teamId: string, threadId: string, status: string): Promise<string> {
  const id = randomUUID();
  const queued = status === "queued";
  await admin.query(
    `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at, queue_pos)
     VALUES ($1, $2, $3, 'user', $4, $5, $6)`,
    [teamId, id, threadId, status, queued ? null : new Date(), queued ? 1 : null],
  );
  return id;
}

async function endRun(teamId: string, runId: string): Promise<void> {
  await admin.query(
    `UPDATE runs SET status = 'cancelled', ended_at = now(), queue_pos = NULL
     WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "t".repeat(48),
    setupToken: "setup-token-for-thread-tests-01",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const installRole = who === "owner" ? "owner" : who === "installAdmin" ? "admin" : undefined;
    const user = await deps.createUserWithPassword(
      { email: email(who), name: who, password: PASSWORD },
      installRole ? { installRole } : {},
    );
    ids[who] = user.id;
  }
  as = Object.fromEntries(
    await Promise.all(PEOPLE.map(async (w) => [w, await signIn(w)])),
  ) as Record<Person, TestBrowser>;

  const create = async (slug: string, adminUser: Person) => {
    const res = await as.owner.post("/v1/install/teams", {
      slug,
      name: slug,
      adminUserId: ids[adminUser],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.team.id as string;
  };
  finance = await create("finance", "alice");
  marketing = await create("marketing", "dave");
  await activate(as.alice, finance);
  await addMember(as.alice, "bob", "member");
  await addMember(as.alice, "carol", "builder");
  await activate(as.dave, marketing);
  await addMember(as.dave, "bob", "member");
  await activate(as.bob, finance);
  await activate(as.carol, finance);
});

/** Pool#end resolves before idle connections close; wait so DROP … WITH (FORCE) kills nothing. */
async function waitForAppSessionsToClose(): Promise<void> {
  const server = new pg.Client({ connectionString: testServerUrl() });
  await server.connect();
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await server.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`,
        [database.appRole],
      );
      if (rows[0]?.n === 0) return;
      if (Date.now() > deadline) throw new Error("app-role sessions still open after 10 s");
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await server.end();
  }
}

afterAll(async () => {
  await deps?.close();
  await admin?.end();
  if (database) {
    await waitForAppSessionsToClose();
    await database.drop();
  }
});

describe("create (POST /v1/threads)", () => {
  it("creates a thread owned by the caller in the active team", async () => {
    const res = await as.bob.post("/v1/threads", { title: "  Quarterly numbers  " });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      title: "Quarterly numbers",
      status: "idle",
      owner_user_id: ids.bob,
      project_id: null,
      agent_id: null,
      agent_version: null,
      shared_to_project: false,
      leaf_entry_id: null,
      deleted_at: null,
      purge_after: null,
    });
    const { rows } = await admin.query(`SELECT team_id, owner_user_id FROM threads WHERE id = $1`, [
      res.json.thread_id,
    ]);
    expect(rows).toEqual([{ team_id: finance, owner_user_id: ids.bob }]);
  });

  it("takes the team and owner from the session, never from the body", async () => {
    expect((await as.bob.post("/v1/threads", { team_id: marketing })).status).toBe(400);
    expect((await as.bob.post("/v1/threads", { owner_user_id: ids.alice })).status).toBe(400);
  });

  it("refuses agents and projects that don't exist (until KOBE-45/57)", async () => {
    expect(await as.bob.post("/v1/threads", { agent_id: randomUUID() })).toMatchObject({
      status: 404,
      json: { code: "agent_not_found" },
    });
    expect(await as.bob.post("/v1/threads", { project_id: randomUUID() })).toMatchObject({
      status: 404,
      json: { code: "project_not_found" },
    });
    expect((await as.bob.post("/v1/threads", { agent_id: null, project_id: null })).status).toBe(
      201,
    );
  });

  it("validates the body", async () => {
    for (const body of [{ title: "" }, { title: 7 }, { agent_id: "assistant" }, { x: 1 }]) {
      expect((await as.bob.post("/v1/threads", body)).status, JSON.stringify(body)).toBe(400);
    }
    const raw = await as.bob.request("POST", "/v1/threads", undefined, {
      "content-type": "application/json",
    });
    expect(raw.status).toBe(400);
  });

  it("needs X-Kobe-Team on changes and an active team", async () => {
    const tab = await signIn("bob");
    expect((await tab.post("/v1/threads", {})).json.code).toBe("team_header_required");
    tab.team = finance;
    expect(await tab.post("/v1/threads", {})).toMatchObject({
      status: 409,
      json: { code: "no_active_team" },
    });
  });
});

describe("authorization per role (ac-3)", () => {
  it("lets every team role chat: member, builder and team admin", async () => {
    for (const who of ["bob", "carol", "alice"] as const) {
      const id = await newThread(as[who]);
      expect((await as[who].get(`/v1/threads/${id}`)).status, who).toBe(200);
      expect((await as[who].get("/v1/threads")).status, who).toBe(200);
    }
  });

  it("refuses install admins who are not members, and users without a team", async () => {
    for (const who of ["installAdmin", "owner", "erin"] as const) {
      const res = await as[who].get("/v1/threads");
      expect(res, who).toMatchObject({ status: 409, json: { code: "no_active_team" } });
      const select = await as[who].put("/v1/me/teams/active", { teamId: finance });
      expect(select.status, who).toBe(403);
    }
  });

  it("refuses a member removed from the team at once", async () => {
    await addMember(as.alice, "erin", "member");
    await activate(as.erin, finance);
    const id = await newThread(as.erin);
    const removed = await as.alice.delete(`/v1/team/members/${ids.erin}`);
    expect(removed.status).toBe(204);
    expect((await as.erin.get(`/v1/threads/${id}`)).json.code).toBe("not_a_team_member");
    expect((await as.erin.get("/v1/threads")).status).toBe(403);
  });

  it("requires a session", async () => {
    const anonymous = new TestBrowser(app, PUBLIC_URL);
    expect((await anonymous.get("/v1/threads")).status).toBe(401);
  });
});

describe("visibility: private threads, team admins and other teams", () => {
  let bobs = "";
  const notFound = { status: 404, json: { code: "thread_not_found" } };

  beforeAll(async () => {
    bobs = await newThread(as.bob, { title: "bob's private thread" });
    await appendEntries(finance, bobs, [{ id: "e1", parent: null }]);
  });

  it("hides another member's thread from team admins and builders, like an unknown id", async () => {
    const unknown = await as.alice.get(`/v1/threads/${randomUUID()}`);
    expect(unknown).toMatchObject(notFound);
    for (const who of ["alice", "carol"] as const) {
      const paths = [`/v1/threads/${bobs}`, `/v1/threads/${bobs}/entries`];
      for (const path of paths) expect(await as[who].get(path), `${who} ${path}`).toEqual(unknown);
      expect(await as[who].patch(`/v1/threads/${bobs}`, { title: "mine" })).toEqual(unknown);
      expect(await as[who].post(`/v1/threads/${bobs}/leaf`, { entry_id: "e1" })).toEqual(unknown);
      expect(await as[who].delete(`/v1/threads/${bobs}`)).toEqual(unknown);
      expect(await as[who].post(`/v1/threads/${bobs}/restore`)).toEqual(unknown);
      const list = await as[who].get("/v1/threads?limit=100");
      expect(list.json.threads.map((t: { thread_id: string }) => t.thread_id)).not.toContain(bobs);
    }
  });

  it("never reaches another team's thread, even for its own owner", async () => {
    const bobInMarketing = await signIn("bob");
    await activate(bobInMarketing, marketing);
    const unknown = await bobInMarketing.get(`/v1/threads/${randomUUID()}`);
    expect(unknown).toMatchObject(notFound);
    expect(await bobInMarketing.get(`/v1/threads/${bobs}`)).toEqual(unknown);
    expect(await bobInMarketing.patch(`/v1/threads/${bobs}`, { title: "x" })).toEqual(unknown);
    expect(await bobInMarketing.delete(`/v1/threads/${bobs}`)).toEqual(unknown);
    expect(await bobInMarketing.post(`/v1/threads/${bobs}/leaf`, { entry_id: "e1" })).toEqual(
      unknown,
    );
    const list = await bobInMarketing.get("/v1/threads?limit=100");
    expect(list.json.threads).toEqual([]);
    // The marketing team admin sees nothing of finance either.
    expect(await as.dave.get(`/v1/threads/${bobs}`)).toEqual(unknown);
    // Threads made in marketing stay there.
    const there = await newThread(bobInMarketing);
    expect((await as.bob.get(`/v1/threads/${there}`)).status).toBe(404);
    const { rows } = await admin.query(`SELECT team_id FROM threads WHERE id = $1`, [there]);
    expect(rows).toEqual([{ team_id: marketing }]);
  });

  it("rejects a stale tab whose X-Kobe-Team names another team", async () => {
    const res = await as.bob.request(
      "PATCH",
      `/v1/threads/${bobs}`,
      { title: "t" },
      {
        "x-kobe-team": marketing,
      },
    );
    expect(res).toMatchObject({ status: 409, json: { code: "team_mismatch" } });
  });

  it("validates ids in the path", async () => {
    expect((await as.bob.get("/v1/threads/not-a-uuid")).status).toBe(400);
    const upper = await as.bob.get(`/v1/threads/${bobs.toUpperCase()}`);
    expect(upper).toMatchObject({ status: 200, json: { thread_id: bobs } });
  });
});

describe("shared project threads (D23, data layer until projects exist)", () => {
  const project = randomUUID();
  let shared = "";

  beforeAll(async () => {
    // Projects arrive with KOBE-57; the thread row can already carry a project id.
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO threads (team_id, owner_user_id, project_id, title) VALUES ($1, $2, $3, 'plan')
       RETURNING id`,
      [finance, ids.alice, project],
    );
    shared = rows[0]?.id ?? "";
    expect(shared).not.toBe("");
  });

  const viewer = (who: Person, projectIds: string[]) => ({
    teamId: finance,
    userId: ids[who],
    projectIds,
  });

  it("lets the owner share a project thread; members of the project read it, read-only", async () => {
    expect(
      (await as.alice.patch(`/v1/threads/${shared}`, { shared_to_project: true })).status,
    ).toBe(200);
    const db = deps.database.db;
    const asBob = await withTeam(db, finance, (tx) =>
      findThread(tx, viewer("bob", [project]), shared),
    );
    expect(asBob?.access).toBe("reader");
    const notMember = await withTeam(db, finance, (tx) =>
      findThread(tx, viewer("bob", [randomUUID()]), shared),
    );
    expect(notMember).toBeNull();
    const change = await withTeam(db, finance, (tx) =>
      updateThread(tx, viewer("bob", [project]), shared, { title: "hijack" }),
    );
    expect(change).toEqual({ ok: false, error: "read_only" });
    // Another team never sees it, whatever project ids are claimed.
    const otherTeam = await withTeam(db, marketing, (tx) =>
      findThread(tx, { teamId: marketing, userId: ids.bob, projectIds: [project] }, shared),
    );
    expect(otherTeam).toBeNull();
  });

  it("hides an unshared or trashed project thread from project members", async () => {
    const db = deps.database.db;
    await as.alice.patch(`/v1/threads/${shared}`, { shared_to_project: false });
    expect(
      await withTeam(db, finance, (tx) => findThread(tx, viewer("bob", [project]), shared)),
    ).toBeNull();
    await as.alice.patch(`/v1/threads/${shared}`, { shared_to_project: true });
    await as.alice.delete(`/v1/threads/${shared}`);
    expect(
      await withTeam(db, finance, (tx) => findThread(tx, viewer("bob", [project]), shared)),
    ).toBeNull();
    await as.alice.post(`/v1/threads/${shared}/restore`);
  });

  it("only shares threads that belong to a project", async () => {
    const plain = await newThread(as.alice);
    expect(await as.alice.patch(`/v1/threads/${plain}`, { shared_to_project: true })).toMatchObject(
      { status: 409, json: { code: "not_in_project" } },
    );
  });

  it("lists a project's threads the viewer may read", async () => {
    const res = await as.alice.get(`/v1/threads?project_id=${project}`);
    expect(res.json.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([shared]);
    expect((await as.bob.get(`/v1/threads?project_id=${project}`)).json.threads).toEqual([]);
  });
});

describe("read with entries (GET /v1/threads/{id})", () => {
  let id = "";

  beforeAll(async () => {
    id = await newThread(as.carol, { title: "branches" });
    // e1 → e2 → e3, and an edit of e2 (e2b) branching from e1, plus an offloaded body.
    await appendEntries(finance, id, [
      { id: "e1", parent: null },
      { id: "e2", parent: "e1" },
      { id: "e3", parent: "e2" },
      { id: "e2b", parent: "e1" },
      { id: "big", parent: "e2b", blob: true },
    ]);
    await admin.query(`UPDATE threads SET leaf_entry_id = 'e3' WHERE id = $1`, [id]);
  });

  it("returns the thread, the whole entry tree in append order and the leaf", async () => {
    const res = await as.carol.get(`/v1/threads/${id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      thread_id: id,
      leaf_entry_id: "e3",
      agent_version: null,
      status: "idle",
      next_entries_after: null,
    });
    expect(
      res.json.entries.map((e: { entry_id: string; parent_id: string | null; seq: number }) => [
        e.entry_id,
        e.parent_id,
        e.seq,
      ]),
    ).toEqual([
      ["e1", null, 1],
      ["e2", "e1", 2],
      ["e3", "e2", 3],
      ["e2b", "e1", 4],
      ["big", "e2b", 5],
    ]);
    expect(res.json.entries[0]).toMatchObject({
      type: "message",
      payload: { message: { role: "user", content: "text e1" } },
      payload_offloaded: false,
    });
    expect(res.json.entries[4]).toMatchObject({ payload: {}, payload_offloaded: true });
    expect(JSON.stringify(res.json)).not.toContain("blobs/");
  });

  it("pages entries by seq", async () => {
    const first = await as.carol.get(`/v1/threads/${id}?limit=2`);
    expect(first.json.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
    expect(first.json.next_entries_after).toBe(2);
    const second = await as.carol.get(`/v1/threads/${id}/entries?after=2&limit=2`);
    expect(second.json.entries.map((e: { seq: number }) => e.seq)).toEqual([3, 4]);
    const last = await as.carol.get(`/v1/threads/${id}/entries?after=4&limit=2`);
    expect(last.json).toMatchObject({ next_entries_after: null });
    expect(last.json.entries.map((e: { seq: number }) => e.seq)).toEqual([5]);
    expect((await as.carol.get(`/v1/threads/${id}/entries?limit=501`)).status).toBe(400);
  });

  it("returns an empty thread with no entries", async () => {
    const empty = await newThread(as.carol);
    expect((await as.carol.get(`/v1/threads/${empty}`)).json).toMatchObject({
      entries: [],
      next_entries_after: null,
      leaf_entry_id: null,
    });
  });

  it("switches the active branch to an entry of the thread", async () => {
    const res = await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id: "big" });
    expect(res).toMatchObject({ status: 200, json: { leaf_entry_id: "big" } });
    expect((await as.carol.get(`/v1/threads/${id}`)).json.leaf_entry_id).toBe("big");
  });

  it("refuses a leaf that is not an entry of this thread", async () => {
    const other = await newThread(as.carol);
    await appendEntries(finance, other, [{ id: "elsewhere", parent: null }]);
    for (const entry_id of ["nope", "elsewhere"]) {
      expect(await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id })).toMatchObject({
        status: 404,
        json: { code: "entry_not_found" },
      });
    }
    expect((await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id: "" })).status).toBe(400);
  });

  it("refuses to switch the leaf while a run holds the thread", async () => {
    const run = await addRun(finance, id, "running");
    expect(await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id: "e3" })).toMatchObject({
      status: 409,
      json: { code: "thread_busy" },
    });
    await endRun(finance, run);
    expect((await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id: "e3" })).status).toBe(200);
  });
});

describe("rename", () => {
  it("renames and clears the title", async () => {
    const id = await newThread(as.bob, { title: "old" });
    expect(await as.bob.patch(`/v1/threads/${id}`, { title: " new " })).toMatchObject({
      status: 200,
      json: { title: "new" },
    });
    expect((await as.bob.patch(`/v1/threads/${id}`, { title: null })).json.title).toBeNull();
    expect((await as.bob.patch(`/v1/threads/${id}`, {})).status).toBe(400);
    expect((await as.bob.patch(`/v1/threads/${id}`, { status: "idle" })).status).toBe(400);
  });
});

describe("Trash and restore (D18 soft delete)", () => {
  it("moves a thread to Trash, out of the list, and back", async () => {
    const id = await newThread(as.bob, { title: "to trash" });
    const del = await as.bob.delete(`/v1/threads/${id}`);
    expect(del.status).toBe(200);
    const deletedAt = Date.parse(del.json.deleted_at);
    expect(Date.parse(del.json.purge_after) - deletedAt).toBe(30 * 86_400_000);
    expect((await as.bob.delete(`/v1/threads/${id}`)).json.deleted_at).toBe(del.json.deleted_at);

    const list = await as.bob.get("/v1/threads?limit=100");
    expect(list.json.threads.map((t: { thread_id: string }) => t.thread_id)).not.toContain(id);
    const trash = await as.bob.get("/v1/threads/trash");
    expect(trash.json.threads.map((t: { thread_id: string }) => t.thread_id)).toContain(id);
    // The owner can still open it; changes wait for restore.
    expect((await as.bob.get(`/v1/threads/${id}`)).json.deleted_at).toBe(del.json.deleted_at);
    expect(await as.bob.patch(`/v1/threads/${id}`, { title: "x" })).toMatchObject({
      status: 409,
      json: { code: "thread_in_trash" },
    });
    expect((await as.bob.post(`/v1/threads/${id}/leaf`, { entry_id: "e" })).status).toBe(409);
    // Another member's Trash is theirs alone.
    const alicesTrash = await as.alice.get("/v1/threads/trash");
    expect(alicesTrash.json.threads.map((t: { thread_id: string }) => t.thread_id)).not.toContain(
      id,
    );

    const restored = await as.bob.post(`/v1/threads/${id}/restore`);
    expect(restored).toMatchObject({ status: 200, json: { deleted_at: null, purge_after: null } });
    expect(await as.bob.post(`/v1/threads/${id}/restore`)).toMatchObject({
      status: 409,
      json: { code: "not_in_trash" },
    });
  });

  it("restores only within 30 days", async () => {
    const id = await newThread(as.bob);
    await as.bob.delete(`/v1/threads/${id}`);
    await admin.query(`UPDATE threads SET deleted_at = now() - interval '31 days' WHERE id = $1`, [
      id,
    ]);
    const trash = await as.bob.get("/v1/threads/trash?limit=100");
    expect(trash.json.threads.map((t: { thread_id: string }) => t.thread_id)).not.toContain(id);
    expect(await as.bob.post(`/v1/threads/${id}/restore`)).toMatchObject({
      status: 404,
      json: { code: "thread_not_found" },
    });
  });

  it("refuses to trash a thread with an active or queued run", async () => {
    const id = await newThread(as.bob);
    for (const status of ["running", "waiting_approval", "queued"]) {
      const run = await addRun(finance, id, status);
      expect(await as.bob.delete(`/v1/threads/${id}`), status).toMatchObject({
        status: 409,
        json: { code: "thread_busy" },
      });
      await endRun(finance, run);
    }
    expect((await as.bob.delete(`/v1/threads/${id}`)).status).toBe(200);
  });
});

describe("list pagination (GET /v1/threads)", () => {
  let dave: TestBrowser;
  let made: string[] = [];

  beforeAll(async () => {
    // A fresh member with only these threads: some share a timestamp to the microsecond, some
    // differ by a microsecond, so ordering relies on the id tiebreak and µs-precise cursors.
    dave = as.dave;
    made = [];
    for (let i = 0; i < 9; i++) made.push(await newThread(dave, { title: `t${i}` }));
    const stamps = [
      "2026-10-01 12:00:00.000001+00",
      "2026-10-01 12:00:00.000001+00",
      "2026-10-01 12:00:00.000001+00",
      "2026-10-01 12:00:00.000002+00",
      "2026-10-01 12:00:00.000002+00",
      "2026-10-01 12:00:00.0000025+00",
      "2026-10-01 12:00:00.000003+00",
      "2026-09-30 00:00:00+00",
      "2026-10-01 12:00:00.000999+00",
    ];
    for (const [i, id] of made.entries()) {
      await admin.query(`UPDATE threads SET last_activity_at = $2 WHERE id = $1`, [id, stamps[i]]);
    }
  });

  async function walk(b: TestBrowser, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 50; pages++) {
      const qs: string = cursor ? `&cursor=${cursor}` : "";
      const res = await b.get(`/v1/threads?limit=${limit}${qs}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      seen.push(...res.json.threads.map((t: { thread_id: string }) => t.thread_id));
      cursor = res.json.next_cursor;
      if (!cursor) return seen;
    }
    throw new Error("pagination did not end");
  }

  it("returns every thread exactly once, newest activity first, id breaking ties", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `SELECT id FROM threads WHERE team_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
       ORDER BY last_activity_at DESC, id DESC`,
      [marketing, ids.dave],
    );
    const expected = rows.map((r) => r.id);
    expect(expected).toHaveLength(9);
    for (const limit of [1, 2, 3, 4, 100])
      expect(await walk(dave, limit), `${limit}`).toEqual(expected);
  });

  it("stays stable while threads gain activity or are created between pages", async () => {
    const first = await dave.get("/v1/threads?limit=4");
    const firstIds = first.json.threads.map((t: { thread_id: string }) => t.thread_id);
    // A new thread and a bumped thread from page 1 move to the top: neither appears on later
    // pages, and nothing after the cursor is skipped or repeated.
    await newThread(dave, { title: "new between pages" });
    await admin.query(`UPDATE threads SET last_activity_at = now() WHERE id = $1`, [firstIds[3]]);
    const rest: string[] = [];
    let cursor: string | null = first.json.next_cursor;
    while (cursor) {
      const res = await dave.get(`/v1/threads?limit=4&cursor=${cursor}`);
      rest.push(...res.json.threads.map((t: { thread_id: string }) => t.thread_id));
      cursor = res.json.next_cursor;
    }
    expect([...firstIds, ...rest].sort()).toEqual([...made].sort());
  });

  it("rejects malformed cursors and limits", async () => {
    expect(await dave.get("/v1/threads?cursor=garbage")).toMatchObject({
      status: 400,
      json: { code: "invalid_cursor" },
    });
    const extreme = Buffer.from(
      JSON.stringify({ a: "99999999999999999", i: "ffffffff-ffff-4fff-bfff-ffffffffffff" }),
    ).toString("base64url");
    expect((await dave.get(`/v1/threads?cursor=${extreme}`)).status).toBe(200);
    expect((await dave.get("/v1/threads?limit=0")).status).toBe(400);
    expect((await dave.get("/v1/threads?limit=101")).status).toBe(400);
    expect((await dave.get("/v1/threads?team_id=x")).status).toBe(400);
    expect((await dave.get("/v1/threads/trash?cursor=garbage")).status).toBe(400);
  });

  it("pages the Trash by deletion time", async () => {
    const trashed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await newThread(dave);
      expect((await dave.delete(`/v1/threads/${id}`)).status).toBe(200);
      trashed.unshift(id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : "";
      const res = await dave.get(`/v1/threads/trash?limit=1${qs}`);
      seen.push(...res.json.threads.map((t: { thread_id: string }) => t.thread_id));
      cursor = res.json.next_cursor;
    } while (cursor);
    expect(seen).toEqual(trashed);
  });
});

describe("security review fixes", () => {
  it("never returns a stored payload for an offloaded entry", async () => {
    const id = await newThread(as.bob);
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, type, payload, blob_ref)
       VALUES ($1, $2, 'off', 'message', '{"message":{"content":"inline copy"}}', 'blobs/off')`,
      [finance, id],
    );
    for (const path of [`/v1/threads/${id}`, `/v1/threads/${id}/entries`]) {
      const res = await as.bob.get(path);
      expect(res.json.entries, path).toEqual([
        expect.objectContaining({ entry_id: "off", payload: {}, payload_offloaded: true }),
      ]);
      expect(JSON.stringify(res.json)).not.toContain("inline copy");
    }
  });

  it("answers thread_busy instead of waiting when the thread row stays locked", async () => {
    const id = await newThread(as.bob);
    await appendEntries(finance, id, [{ id: "l1", parent: null }]);
    await as.bob.delete(`/v1/threads/${id}`);
    await as.bob.post(`/v1/threads/${id}/restore`);
    // An appender (seq trigger) or another writer holding the row past the lock timeout.
    const holder = new pg.Client({ connectionString: database.adminUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM threads WHERE id = $1 FOR UPDATE", [id]);
      const calls = [
        () => as.bob.patch(`/v1/threads/${id}`, { title: "x" }),
        () => as.bob.post(`/v1/threads/${id}/leaf`, { entry_id: "l1" }),
        () => as.bob.delete(`/v1/threads/${id}`),
        () => as.bob.post(`/v1/threads/${id}/restore`),
      ];
      for (const call of calls) {
        const started = Date.now();
        expect(await call()).toMatchObject({ status: 409, json: { code: "thread_busy" } });
        expect(Date.now() - started).toBeLessThan(5_000);
      }
      // Reads don't lock and are not blocked.
      expect((await as.bob.get(`/v1/threads/${id}`)).status).toBe(200);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect((await as.bob.patch(`/v1/threads/${id}`, { title: "x" })).status).toBe(200);
  });

  it("treats Trash older than 30 days as gone everywhere", async () => {
    const id = await newThread(as.bob);
    await appendEntries(finance, id, [{ id: "x1", parent: null }]);
    await as.bob.delete(`/v1/threads/${id}`);
    await admin.query(`UPDATE threads SET deleted_at = now() - interval '31 days' WHERE id = $1`, [
      id,
    ]);
    const gone = { status: 404, json: { code: "thread_not_found" } };
    expect(await as.bob.get(`/v1/threads/${id}`)).toMatchObject(gone);
    expect(await as.bob.get(`/v1/threads/${id}/entries`)).toMatchObject(gone);
    expect(await as.bob.delete(`/v1/threads/${id}`)).toMatchObject(gone);
    expect(await as.bob.patch(`/v1/threads/${id}`, { title: "t" })).toMatchObject(gone);
    expect(await as.bob.post(`/v1/threads/${id}/leaf`, { entry_id: "x1" })).toMatchObject(gone);
    expect(await as.bob.post(`/v1/threads/${id}/restore`)).toMatchObject(gone);
  });
});

describe("responses match the OpenAPI schemas (ac-1)", () => {
  it("returns exactly the documented fields", async () => {
    const summary = threadSummarySchema.strict();
    const entry = threadEntrySchema.strict();
    const created = await as.bob.post("/v1/threads", { title: "schema" });
    summary.parse(created.json);
    const id = created.json.thread_id as string;
    await appendEntries(finance, id, [
      { id: "s1", parent: null },
      { id: "s2", parent: "s1" },
    ]);
    threadDetailSchema
      .extend({ entries: entry.array() })
      .strict()
      .parse((await as.bob.get(`/v1/threads/${id}`)).json);
    entryPageSchema
      .extend({ entries: entry.array() })
      .strict()
      .parse((await as.bob.get(`/v1/threads/${id}/entries?after=1`)).json);
    threadPageSchema
      .extend({ threads: summary.array() })
      .strict()
      .parse((await as.bob.get("/v1/threads")).json);
    summary.parse((await as.bob.patch(`/v1/threads/${id}`, { title: "s" })).json);
    summary.parse((await as.bob.post(`/v1/threads/${id}/leaf`, { entry_id: "s2" })).json);
    summary.parse((await as.bob.delete(`/v1/threads/${id}`)).json);
    threadPageSchema
      .extend({ threads: summary.array() })
      .strict()
      .parse((await as.bob.get("/v1/threads/trash")).json);
    summary.parse((await as.bob.post(`/v1/threads/${id}/restore`)).json);
  });
});

describe("search (GET /v1/threads?q=, KOBE-33)", () => {
  /** Appends a Pi user message with `text` as the database owner would (writers: KOBE-30/23). */
  async function say(teamId: string, threadId: string, entryId: string, text: string) {
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, type, payload)
       VALUES ($1, $2, $3, 'message', $4)`,
      [teamId, threadId, entryId, JSON.stringify({ message: { role: "user", content: text } })],
    );
  }
  const searchIds = async (b: TestBrowser, q: string): Promise<string[]> => {
    const res = await b.get(`/v1/threads?q=${encodeURIComponent(q)}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return threadSearchPageSchema.parse(res.json).threads.map((t) => t.thread_id);
  };

  it("finds the viewer's thread by message text, with summary, matched entry and snippet", async () => {
    const id = await newThread(as.bob, { title: "Budget review" });
    await say(finance, id, "s1", "the narwhal forecast for Q4");
    const res = await as.bob.get("/v1/threads?q=narwhal");
    expect(res.status).toBe(200);
    const page = threadSearchPageSchema.parse(res.json);
    expect(page.next_cursor).toBeNull();
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]).toMatchObject({
      thread_id: id,
      title: "Budget review",
      owner_user_id: ids.bob,
      deleted_at: null,
      matched_entry_id: "s1",
    });
    expect(page.threads[0]?.snippet?.filter((s) => s.highlight).map((s) => s.text)).toEqual([
      "narwhal",
    ]);
    // Title search, and the summary equals what the thread read returns.
    const [hit] = threadSearchPageSchema.parse(
      (await as.bob.get("/v1/threads?q=budget")).json,
    ).threads;
    const detail = threadDetailSchema.parse((await as.bob.get(`/v1/threads/${id}`)).json);
    const {
      entries: _e,
      next_entries_after: _n,
      agent_current_version: _v,
      agent_model: _am,
      agent_name: _an,
      agent_status: _as,
      ...summary
    } = detail;
    const { matched_entry_id: _m, snippet: _s, score: _sc, ...hitSummary } = hit ?? {};
    expect(hitSummary).toEqual(summary);
  });

  it("never returns another user's private thread, not even to the team admin", async () => {
    const id = await newThread(as.carol);
    await say(finance, id, "p1", "carol's pangolin plan");
    expect(await searchIds(as.carol, "pangolin")).toEqual([id]);
    expect(await searchIds(as.bob, "pangolin")).toEqual([]);
    expect(await searchIds(as.alice, "pangolin")).toEqual([]);
  });

  it("is scoped to the active team, even for the same user's own threads", async () => {
    const inFinance = await newThread(as.bob);
    await say(finance, inFinance, "q1", "quasar in finance");
    await activate(as.bob, marketing);
    try {
      const inMarketing = await newThread(as.bob);
      await say(marketing, inMarketing, "q1", "quasar in marketing");
      expect(await searchIds(as.bob, "quasar")).toEqual([inMarketing]);
      expect(await searchIds(as.dave, "quasar")).toEqual([]);
    } finally {
      await activate(as.bob, finance);
    }
    expect(await searchIds(as.bob, "quasar")).toEqual([inFinance]);
  });

  it("leaves out Trash", async () => {
    const id = await newThread(as.bob);
    await say(finance, id, "t1", "binned wombat");
    expect(await searchIds(as.bob, "wombat")).toEqual([id]);
    expect((await as.bob.delete(`/v1/threads/${id}`)).status).toBe(200);
    expect(await searchIds(as.bob, "wombat")).toEqual([]);
  });

  it("pages with a search cursor and caps limit at 50", async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await newThread(as.bob);
      await say(finance, id, "c1", `capybara note ${i}`);
      created.push(id);
    }
    const first = await as.bob.get("/v1/threads?q=capybara&limit=2");
    const page1 = threadSearchPageSchema.parse(first.json);
    expect(page1.threads).toHaveLength(2);
    const second = await as.bob.get(
      `/v1/threads?q=capybara&limit=2&cursor=${encodeURIComponent(page1.next_cursor ?? "")}`,
    );
    const page2 = threadSearchPageSchema.parse(second.json);
    expect(page2.next_cursor).toBeNull();
    expect([...page1.threads, ...page2.threads].map((t) => t.thread_id).sort()).toEqual(
      created.sort(),
    );
    expect((await as.bob.get("/v1/threads?q=capybara&limit=100")).status).toBe(200);
  });

  it("answers 400 for an empty or negation-only query and for a bad cursor", async () => {
    expect((await as.bob.get("/v1/threads?q=%20%20")).json).toMatchObject({
      code: "invalid_request",
    });
    expect(await as.bob.get(`/v1/threads?q=${encodeURIComponent('-alpha -"b c"')}`)).toMatchObject({
      status: 400,
      json: { code: "invalid_query" },
    });
    expect(await as.bob.get("/v1/threads?q=alpha&cursor=bogus")).toMatchObject({
      status: 400,
      json: { code: "invalid_cursor" },
    });
  });

  it("answers 503 search_timeout when the search exceeds its time limit, and stays usable", async () => {
    const id = await newThread(as.bob);
    await say(finance, id, "l1", "locked ocelot");
    const locker = new pg.Client({ connectionString: database.adminUrl });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE thread_entries IN ACCESS EXCLUSIVE MODE");
      const res = await as.bob.get("/v1/threads?q=ocelot");
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ code: "search_timeout" });
      expect(JSON.stringify(res.json)).not.toMatch(/select|ocelot/i);
    } finally {
      await locker.query("ROLLBACK");
      await locker.end();
    }
    expect(await searchIds(as.bob, "ocelot")).toEqual([id]);
  }, 20_000);
});

describe("history reads never wake sandboxes (ac-2)", () => {
  it("serves thread reads from Postgres alone", async () => {
    // Deps that expose only the database and the session check: any other dependency (sandbox
    // orchestration, isolation, user management) throws if a read path touches it.
    // `agentLimits` is static configuration the agent routes read when mounted (KOBE-46);
    // `runAgents.pinnedModel` (KOBE-44) reads the agent's model pin in the read's transaction.
    const allowed = new Set<PropertyKey>([
      "database",
      "auth",
      "publicUrl",
      "agentLimits",
      "runAgents",
    ]);
    const readOnlyDeps = new Proxy(deps, {
      get(target, prop, receiver) {
        if (!allowed.has(prop)) throw new Error(`thread read touched deps.${String(prop)}`);
        return Reflect.get(target, prop, receiver);
      },
    });
    const isolatedApp = createApp(readOnlyDeps);
    const b = new TestBrowser(isolatedApp, PUBLIC_URL);
    for (const [k, v] of as.bob.cookies) b.cookies.set(k, v);
    const id = await newThread(as.bob);
    for (const path of [
      "/v1/threads",
      `/v1/threads/${id}`,
      `/v1/threads/${id}/entries`,
      "/v1/threads/trash",
    ]) {
      expect((await b.get(path)).status, path).toBe(200);
    }
  });
});
