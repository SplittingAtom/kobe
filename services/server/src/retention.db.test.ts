import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "./audit/context.js";
import {
  RetentionJob,
  StillAMemberError,
  purgeDepartedMember,
  runRetentionPass,
  type BlobStore,
} from "./retention/index.js";
import { createTeamWithAdmin } from "./teams/members.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-18 end to end: team retention settings within the install maximum, the nightly pass
 * (Trash purge, retention purge, run_events compaction, released blobs), legal hold suspending
 * every purge, "Delete forever", the user's export, and the offboarding entry point for KOBE-28.
 */
let h: Harness;
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs: BlobStore = { objects, prefix: PREFIX };
const log = pino({ level: "silent" });
const ids = { owner: "", admin: "", alice: "", bob: "", carol: "" };
let as: Record<"owner" | "alice" | "bob" | "carol", TestBrowser>;
let team = "";
let other = "";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function makeTeam(slug: string, adminId: string): Promise<string> {
  return (
    await runWithAuditContext(
      { actor: { kind: "user", id: adminId }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug, name: slug }, adminId),
    )
  ).id;
}

async function member(teamId: string, userId: string, role = "member"): Promise<void> {
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [teamId, userId, role],
  );
}

interface ThreadSpec {
  readonly teamId?: string;
  readonly owner: string;
  readonly title?: string;
  readonly activity?: Date;
  readonly deletedAt?: Date | null;
  /** Object keys stored as entry blob refs (and put into the bucket). */
  readonly blobKeys?: readonly string[];
  readonly entries?: number;
}

/** A thread with a chain of user/assistant message entries (superuser fixture). */
async function thread(spec: ThreadSpec): Promise<string> {
  const teamId = spec.teamId ?? team;
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, $4)`,
    [teamId, id, spec.owner, spec.title ?? `t-${id.slice(0, 4)}`],
  );
  let parent: string | null = null;
  const n = spec.entries ?? 2;
  for (let i = 1; i <= n; i++) {
    const entryId = `e${i}`;
    const role = i % 2 === 1 ? "user" : "assistant";
    const content =
      role === "user"
        ? `question ${i} from ${spec.title ?? id}`
        : [{ type: "text", text: `answer ${i}` }];
    const payload = {
      type: "message",
      id: entryId,
      parentId: parent,
      timestamp: new Date().toISOString(),
      message: { role, content },
    };
    const blobKey = spec.blobKeys?.[i - 1] ?? null;
    await h.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref)
       VALUES ($1, $2, $3, $4, 'message', $5, $6)`,
      [teamId, id, entryId, parent, blobKey === null ? payload : {}, blobKey],
    );
    if (blobKey !== null) objects.objects.set(blobKey, Buffer.from(JSON.stringify(payload)));
    parent = entryId;
  }
  for (const key of spec.blobKeys?.slice(n) ?? []) objects.objects.set(key, Buffer.from("x"));
  await h.admin.query(
    `UPDATE threads SET leaf_entry_id = $3, last_activity_at = $4, deleted_at = $5
      WHERE team_id = $1 AND id = $2`,
    [teamId, id, parent, spec.activity ?? new Date(), spec.deletedAt ?? null],
  );
  return id;
}

/** An ended run with `events` run events, ended `endedDaysAgo` ago. */
async function endedRun(threadId: string, endedDaysAgo: number, events = 3, teamId = team) {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
     VALUES ($1, $2, 'user', 'completed', $3, $3) RETURNING id`,
    [teamId, threadId, ago(endedDaysAgo)],
  );
  const runId = rows[0]?.id ?? "";
  for (let i = 0; i < events; i++) {
    await h.admin.query(
      `INSERT INTO run_events (team_id, run_id, type, payload) VALUES ($1, $2, 'run.started', '{}')`,
      [teamId, runId],
    );
  }
  return runId;
}

const key = (name: string, teamId = team) => `${PREFIX}teams/${teamId}/uploads/${name}`;

async function threadIds(teamId = team): Promise<string[]> {
  const { rows } = await h.admin.query<{ id: string }>(
    `SELECT id FROM threads WHERE team_id = $1 ORDER BY id`,
    [teamId],
  );
  return rows.map((r) => r.id);
}

async function audits(action: string, teamId: string | null = team) {
  const { rows } = await h.admin.query<{
    actor_kind: string;
    actor_id: string | null;
    target: Record<string, unknown>;
  }>(
    `SELECT actor_kind, actor_id, target FROM audit_log
      WHERE action = $1 AND team_id IS NOT DISTINCT FROM $2 ORDER BY seq`,
    [action, teamId],
  );
  return rows;
}

async function placeHold(teamId: string, userId: string | null): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter 18', $3)
     RETURNING id`,
    [teamId, userId, ids.admin],
  );
  const id = rows[0]?.id ?? "";
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    ids.owner,
  ]);
  return id;
}

async function releaseHold(id: string): Promise<void> {
  await h.admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
       release_reason = 'matter closed' WHERE id = $1`,
    [id, ids.admin],
  );
  await h.admin.query(
    `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
    [id, ids.owner],
  );
}

/** A download with the browser's cookies, as raw bytes (the zip is binary). */
async function download(b: TestBrowser, path: string) {
  const res = await h.app.request(`http://kobe.test${path}`, {
    headers: {
      origin: "http://kobe.test",
      "x-forwarded-for": b.ip,
      cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
  });
  return {
    status: res.status,
    headers: res.headers,
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
}

const pass = () => runRetentionPass({ db: h.deps.database.db, blobs, logger: log });

async function setPeriod(teamId: string, period: string): Promise<void> {
  await h.admin.query(
    `INSERT INTO team_retention (team_id, period, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (team_id) DO UPDATE SET period = EXCLUDED.period`,
    [teamId, period, ids.alice],
  );
}

beforeAll(async () => {
  h = await openHarness({ blobs });
  ids.owner = await h.createUser("owner@ret.test", "owner");
  ids.admin = await h.createUser("admin@ret.test", "admin");
  ids.alice = await h.createUser("alice@ret.test");
  ids.bob = await h.createUser("bob@ret.test");
  ids.carol = await h.createUser("carol@ret.test");
  team = await makeTeam("finance", ids.alice);
  other = await makeTeam("legal", ids.alice);
  await member(team, ids.bob);
  await member(team, ids.carol);
  await member(other, ids.bob);
  as = {
    owner: await h.signIn("owner@ret.test"),
    alice: await h.signIn("alice@ret.test"),
    bob: await h.signIn("bob@ret.test"),
    carol: await h.signIn("carol@ret.test"),
  };
  for (const who of ["alice", "bob", "carol"] as const) {
    expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    as[who].team = team;
  }
}, 120_000);

afterAll(() => h?.close());

/** Every test starts from empty teams (fixtures are created per test). */
beforeEach(async () => {
  await h.admin.query(`DELETE FROM threads WHERE team_id IN ($1, $2)`, [team, other]);
  await h.admin.query(`DELETE FROM retention_blob_deletions`);
  await h.admin.query(`DELETE FROM team_retention`);
  await h.admin.query(`DELETE FROM install_settings WHERE key LIKE 'retention.%'`);
  objects.objects.clear();
  objects.deleted.length = 0;
});

describe("retention settings (D6, D8)", () => {
  it("defaults to forever; members read it, only team admins change it, within the install maximum", async () => {
    const read = await as.bob.get("/v1/team/retention");
    expect(read.json).toEqual({
      period: "forever",
      maximum: "forever",
      effective: "forever",
      allowed: ["30d", "90d", "1y", "forever"],
    });
    expect((await as.bob.put("/v1/team/retention", { period: "30d" })).status).toBe(403);
    expect((await as.alice.put("/v1/team/retention", { period: "7d" })).status).toBe(400);

    const set = await as.alice.put("/v1/team/retention", { period: "1y" });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ period: "1y", effective: "1y" });
    expect((await audits("retention.policy.changed")).at(-1)).toMatchObject({
      actor_kind: "user",
      actor_id: ids.alice,
      target: { period: "1y", previous: "forever" },
    });

    // Install maximum: install admins only; lowering it caps the team without rewriting it.
    expect((await as.alice.put("/v1/install/retention", { maximum: "90d" })).status).toBe(403);
    const max = await as.owner.put("/v1/install/retention", { maximum: "90d" });
    expect(max.json).toEqual({ maximum: "90d" });
    expect((await audits("retention.maximum.changed", null)).at(-1)?.target).toEqual({
      maximum: "90d",
      previous: "forever",
    });
    expect((await as.bob.get("/v1/team/retention")).json).toMatchObject({
      period: "1y",
      maximum: "90d",
      effective: "90d",
      allowed: ["30d", "90d"],
    });
    const over = await as.alice.put("/v1/team/retention", { period: "forever" });
    expect(over.status).toBe(409);
    expect(over.json.code).toBe("exceeds_maximum");
    expect((await as.alice.put("/v1/team/retention", { period: "30d" })).json.effective).toBe(
      "30d",
    );
  });
});

describe("the nightly pass (D18)", () => {
  it("purges exactly the expired threads and their blobs; shared objects and other teams survive", async () => {
    await setPeriod(team, "90d");
    const old = await thread({
      owner: ids.bob,
      activity: ago(100),
      blobKeys: [key("old-1"), key("shared")],
    });
    const fresh = await thread({ owner: ids.bob, activity: ago(10), blobKeys: [key("fresh")] });
    await thread({
      owner: ids.carol,
      activity: ago(40),
      deletedAt: ago(31),
      blobKeys: [key("trash-1")],
    });
    const trashedRecently = await thread({
      owner: ids.carol,
      activity: ago(40),
      deletedAt: ago(10),
    });
    // An old thread with a queued run is skipped (the next pass retries).
    const busy = await thread({ owner: ids.bob, activity: ago(200) });
    await h.admin.query(
      `INSERT INTO runs (team_id, thread_id, trigger, status, queue_pos) VALUES ($1, $2, 'user', 'queued', 1)`,
      [team, busy],
    );
    // The same object also backs a workspace file (an upload copied into /workspace, KOBE-27).
    await h.admin.query(
      `INSERT INTO workspace_files (team_id, user_id, path, rev, sha256, blob_key, size, mtime_ms, origin)
       VALUES ($1, $2, 'uploads/report.csv', 1, $3, $4, 1, 0, 'server')`,
      [team, ids.bob, "a".repeat(64), key("shared")],
    );
    // Another team: forever (default), same age: untouched.
    const elsewhere = await thread({ teamId: other, owner: ids.bob, activity: ago(400) });

    const result = await pass();

    expect(await threadIds()).toEqual([fresh, trashedRecently, busy].sort());
    expect(await threadIds(other)).toEqual([elsewhere]);
    expect(objects.deleted.sort()).toEqual([key("old-1"), key("trash-1")].sort());
    expect(objects.keys().sort()).toEqual([key("fresh"), key("shared")].sort());
    const mine = result.teams.find((t) => t.teamId === team);
    expect(mine).toMatchObject({
      trash: { threads: 1, entries: 2, blobs: 1 },
      retention: { threads: 1, entries: 2, blobs: 2 },
      blobs: { blobs: 2, kept: 1 },
      failed: false,
    });
    // Audited as counts only, by the system.
    const purged = await audits("retention.purged");
    expect(purged.map((a) => a.target)).toEqual([
      { reason: "trash", threads: 1, entries: 2, runs: 0, events: 0, blobs: 1 },
      { reason: "retention", threads: 1, entries: 2, runs: 0, events: 0, blobs: 2 },
    ]);
    expect(purged.every((a) => a.actor_kind === "system" && a.actor_id === null)).toBe(true);
    expect((await audits("retention.blobs_deleted")).at(-1)?.target).toEqual({ blobs: 2, kept: 1 });
    expect(old).not.toBe(fresh);
    // Nothing left to do: a second pass purges and audits nothing.
    const before = (await audits("retention.purged")).length;
    await pass();
    expect((await audits("retention.purged")).length).toBe(before);
  });

  it("deletes only keys in the team's own key space, never workspace blobs or another team's", async () => {
    await setPeriod(team, "30d");
    const foreign = `${PREFIX}teams/${other}/uploads/x`;
    const workspace = `${PREFIX}teams/${team}/users/${ids.bob}/workspace/${"b".repeat(64)}`;
    const outside = `elsewhere/${team}/x`;
    await thread({ owner: ids.bob, activity: ago(40), blobKeys: [foreign, workspace, outside] });
    await pass();
    expect(objects.deleted).toEqual([]);
    expect(objects.keys().sort()).toEqual([foreign, outside, workspace].sort());
    expect(await threadIds()).toEqual([]);
  });

  it("compacts run events 7 days after the run ended, keeping the entries", async () => {
    const t = await thread({ owner: ids.bob });
    const due = await endedRun(t, 8);
    const recent = await endedRun(t, 6);
    const r = await pass();
    expect(r.teams.find((x) => x.teamId === team)?.compacted).toEqual({ runs: 1, events: 3 });
    const { rows } = await h.admin.query<{ id: string; events: number; compacted: boolean }>(
      `SELECT r.id, (SELECT count(*)::int FROM run_events e WHERE e.team_id = r.team_id AND e.run_id = r.id) AS events,
              r.events_compacted_at IS NOT NULL AS compacted
         FROM runs r WHERE r.team_id = $1 ORDER BY r.ended_at`,
      [team],
    );
    expect(rows).toEqual([
      { id: due, events: 0, compacted: true },
      { id: recent, events: 3, compacted: false },
    ]);
    expect(
      (
        await h.admin.query(`SELECT 1 FROM thread_entries WHERE team_id = $1 AND thread_id = $2`, [
          team,
          t,
        ])
      ).rowCount,
    ).toBe(2);
    expect((await audits("retention.compacted")).at(-1)?.target).toEqual({ runs: 1, events: 3 });
    // The stream of a compacted run answers 410 (KOBE-31 contract).
    const stream = await as.bob.get(`/v1/runs/${due}/events`);
    expect(stream.status).toBe(410);
  });
});

describe("legal hold suspends every purge (KOBE-17 contract)", () => {
  it("skips a held user's expired threads, Trash, compaction and blobs; others' go; release resumes", async () => {
    await setPeriod(team, "30d");
    const held = await thread({ owner: ids.bob, activity: ago(40), blobKeys: [key("held")] });
    const heldTrash = await thread({ owner: ids.bob, activity: ago(40), deletedAt: ago(31) });
    const heldRun = await endedRun(held, 8);
    const free = await thread({ owner: ids.carol, activity: ago(40), blobKeys: [key("free")] });
    const hold = await placeHold(team, ids.bob);

    await pass();
    expect(await threadIds()).toEqual([held, heldTrash].sort());
    expect(objects.keys()).toEqual([key("held")]);
    expect(
      (
        await h.admin.query(`SELECT 1 FROM run_events WHERE team_id = $1 AND run_id = $2`, [
          team,
          heldRun,
        ])
      ).rowCount,
    ).toBe(3);
    expect(free).toBeTruthy();

    await releaseHold(hold);
    await pass();
    expect(await threadIds()).toEqual([]);
    expect(objects.keys()).toEqual([]);
  });

  it("a team-wide hold keeps everything in the team", async () => {
    await setPeriod(team, "30d");
    const a = await thread({ owner: ids.bob, activity: ago(40) });
    const b = await thread({ owner: ids.carol, activity: ago(40), deletedAt: ago(45) });
    const hold = await placeHold(team, null);
    await pass();
    expect(await threadIds()).toEqual([a, b].sort());
    await releaseHold(hold);
  });

  it("keeps the bytes when a hold is placed after the rows were purged", async () => {
    await setPeriod(team, "30d");
    await thread({ owner: ids.bob, activity: ago(40), blobKeys: [key("late")] });
    // Purge the rows but not the blobs (no object store for this pass).
    await runRetentionPass({ db: h.deps.database.db, logger: log });
    expect(await threadIds()).toEqual([]);
    const hold = await placeHold(team, ids.bob);
    await pass();
    expect(objects.keys()).toEqual([key("late")]);
    await releaseHold(hold);
    await pass();
    expect(objects.keys()).toEqual([]);
  });
});

describe("Delete forever (D18: the owner only)", () => {
  it("purges the owner's thread from Trash at once, with its blobs; nobody else can", async () => {
    const t = await thread({ owner: ids.bob, deletedAt: new Date(), blobKeys: [key("gone")] });
    await endedRun(t, 1);
    // Not the owner: the team admin and another member both get "not found".
    expect((await as.alice.post(`/v1/threads/${t}/purge`)).status).toBe(404);
    expect((await as.carol.post(`/v1/threads/${t}/purge`)).status).toBe(404);
    const res = await as.bob.post(`/v1/threads/${t}/purge`);
    expect(res.status).toBe(204);
    expect(await threadIds()).toEqual([]);
    await h.deps.background.idle();
    expect(objects.keys()).toEqual([]);
    expect((await audits("thread.purge_requested")).at(-1)).toMatchObject({
      actor_id: ids.bob,
      target: { threadId: t },
    });
    expect((await audits("thread.purged")).at(-1)?.target).toEqual({
      threadId: t,
      entries: 2,
      runs: 1,
      events: 3,
      blobs: 1,
    });
  });

  it("refuses a thread that is not in Trash, or a thread of another team", async () => {
    const live = await thread({ owner: ids.bob });
    const res = await as.bob.post(`/v1/threads/${live}/purge`);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("not_in_trash");
    const elsewhere = await thread({ teamId: other, owner: ids.bob, deletedAt: new Date() });
    expect((await as.bob.post(`/v1/threads/${elsewhere}/purge`)).status).toBe(404);
    expect(await threadIds(other)).toEqual([elsewhere]);
  });

  it("under a hold: the thread leaves Trash for the user but is kept until the hold is released", async () => {
    const t = await thread({ owner: ids.bob, deletedAt: new Date() });
    const hold = await placeHold(team, ids.bob);
    expect((await as.bob.post(`/v1/threads/${t}/purge`)).status).toBe(204);
    expect(await threadIds()).toEqual([t]);
    expect((await as.bob.get("/v1/threads/trash")).json.threads).toEqual([]);
    expect((await as.bob.post(`/v1/threads/${t}/restore`)).status).toBe(404);
    expect((await audits("thread.purged")).some((a) => a.target.threadId === t)).toBe(false);
    await releaseHold(hold);
    await pass();
    expect(await threadIds()).toEqual([]);
  });
});

describe("export (D18)", () => {
  it("contains only the user's threads in the active team, as Pi JSONL and Markdown", async () => {
    const mine = await thread({ owner: ids.bob, title: "Budget 2027", entries: 4 });
    const trashed = await thread({ owner: ids.bob, title: "Old plan", deletedAt: ago(2) });
    const offloaded = await thread({ owner: ids.bob, title: "Big", blobKeys: [key("big")] });
    const carols = await thread({ owner: ids.carol, title: "Carol secret" });
    const otherTeam = await thread({ teamId: other, owner: ids.bob, title: "Legal matter" });
    const expired = await thread({ owner: ids.bob, title: "Awaiting purge", deletedAt: ago(31) });

    const res = await download(as.bob, `/v1/threads/export?team=${team}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="kobe-finance-/);
    const files = unzipSync(res.bytes);
    const names = Object.keys(files).sort();
    const sessions = names.filter((n) => n.startsWith("sessions/"));
    expect(sessions.sort()).toEqual(
      [mine, trashed, offloaded].map((id) => `sessions/${id}.jsonl`).sort(),
    );
    expect(names.filter((n) => n.startsWith("transcripts/"))).toHaveLength(3);
    expect(names).toEqual(expect.arrayContaining(["README.md", "threads.json"]));
    const all = names.map((n) => strFromU8(files[n] ?? new Uint8Array())).join("\n");
    for (const foreign of [
      carols,
      otherTeam,
      expired,
      "Carol secret",
      "Legal matter",
      "Awaiting purge",
    ]) {
      expect(all).not.toContain(foreign);
    }

    // Pi session format v3: a header line, then the entries in append order.
    const lines = strFromU8(files[`sessions/${mine}.jsonl`] ?? new Uint8Array())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: "session", version: 3, id: mine });
    expect(lines.slice(1).map((e) => [e.id, e.parentId])).toEqual([
      ["e1", null],
      ["e2", "e1"],
      ["e3", "e2"],
      ["e4", "e3"],
    ]);
    // An offloaded body is read back from object storage.
    const big = strFromU8(files[`sessions/${offloaded}.jsonl`] ?? new Uint8Array())
      .trim()
      .split("\n");
    expect(JSON.parse(big[1] ?? "{}")).toMatchObject({ id: "e1", message: { role: "user" } });

    const transcript = names.find((n) => n.startsWith("transcripts/") && n.includes("budget-2027"));
    const md = strFromU8(files[transcript ?? ""] ?? new Uint8Array());
    expect(md).toMatch(/^# Budget 2027/);
    expect(md).toContain("question 1 from Budget 2027");
    expect(md).toContain("answer 4");
    const index = JSON.parse(strFromU8(files["threads.json"] ?? new Uint8Array())) as {
      threads: { id: string; in_trash: boolean }[];
    };
    expect(index.threads.find((t) => t.id === trashed)?.in_trash).toBe(true);
    expect((await audits("thread.exported")).at(-1)).toMatchObject({
      actor_id: ids.bob,
      target: { threads: 3, entries: 8 },
    });

    // Another member's export of the same team holds only their own thread.
    const carolZip = unzipSync((await download(as.carol, "/v1/threads/export")).bytes);
    expect(Object.keys(carolZip).filter((n) => n.startsWith("sessions/"))).toEqual([
      `sessions/${carols}.jsonl`,
    ]);
  });

  it("refuses a stale tab's team", async () => {
    const res = await download(as.bob, `/v1/threads/export?team=${other}`);
    expect(res.status).toBe(409);
  });
});

describe("one replica at a time, once a day", () => {
  it("lets one replica run a pass while another holds the lock; skips when not due", async () => {
    const job = (now?: Date) =>
      new RetentionJob({
        db: h.deps.database.db,
        pool: h.deps.database.pool,
        blobs,
        hourUtc: 3,
        logger: log,
        ...(now ? { now: () => now } : {}),
      });
    const holder = await h.deps.database.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('kobe.retention', 0))");
      expect(await job().tick(true)).toBe("busy");
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('kobe.retention', 0))");
      holder.release();
    }
    const at = new Date("2026-10-04T03:10:00Z");
    expect(await job(at).tick()).toBe("ran");
    // The same night again, and the next day outside the hour: not due.
    expect(await job(new Date("2026-10-04T03:40:00Z")).tick()).toBe("not_due");
    expect(await job(new Date("2026-10-05T12:00:00Z")).tick()).toBe("not_due");
    expect(await job(new Date("2026-10-05T03:05:00Z")).tick()).toBe("ran");
    // Two concurrent ticks: exactly one runs.
    const both = await Promise.all([job().tick(true), job().tick(true)]);
    expect(both.sort()).toEqual(["busy", "ran"]);
  });
});

describe("offboarding (KOBE-28 entry point)", () => {
  it("refuses while the user is an active member, then purges every thread they own in the team", async () => {
    const dave = await h.createUser(`dave-${randomUUID().slice(0, 6)}@ret.test`);
    await member(team, dave);
    const a = await thread({ owner: dave, blobKeys: [key("dave")] });
    await thread({ owner: dave, deletedAt: new Date() });
    const keep = await thread({ owner: ids.bob });
    const elsewhere = await thread({ teamId: other, owner: dave });
    const db = h.deps.database.db;
    await expect(
      purgeDepartedMember(db, { teamId: team, userId: dave }, blobs),
    ).rejects.toBeInstanceOf(StillAMemberError);
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      team,
      dave,
    ]);
    const result = await purgeDepartedMember(db, { teamId: team, userId: dave }, blobs);
    expect(result.threads).toMatchObject({ status: "done", counts: { threads: 2 } });
    expect(result.blobs).toEqual({ blobs: 1, kept: 0 });
    expect(await threadIds()).toEqual([keep]);
    expect(await threadIds(other)).toEqual([elsewhere]);
    expect((await audits("retention.purged")).at(-1)?.target).toMatchObject({
      reason: "offboarding",
      userId: dave,
      threads: 2,
    });
    expect(a).toBeTruthy();
  });

  it("skips a held departed user's threads", async () => {
    const erin = await h.createUser(`erin-${randomUUID().slice(0, 6)}@ret.test`);
    const t = await thread({ owner: erin });
    const hold = await placeHold(team, erin);
    const result = await purgeDepartedMember(
      h.deps.database.db,
      { teamId: team, userId: erin },
      blobs,
    );
    expect(result.threads.counts.threads).toBe(0);
    expect(await threadIds()).toEqual([t]);
    await releaseHold(hold);
  });
});
