import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import type { PoolClient } from "pg";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "./audit/context.js";
import {
  RetentionJob,
  StillAMemberError,
  purgeDepartedMember,
  purgeThreads,
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
  const keys = (spec.blobKeys ?? []).map((k) => {
    if (!k.startsWith("@")) return k;
    const real = `${PREFIX}teams/${teamId}/threads/${id}/${k.slice(1)}`;
    resolved.set(k.slice(1), real);
    return real;
  });
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
    const blobKey = keys[i - 1] ?? null;
    await h.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref)
       VALUES ($1, $2, $3, $4, 'message', $5, $6)`,
      [teamId, id, entryId, parent, blobKey === null ? payload : {}, blobKey],
    );
    if (blobKey !== null) objects.objects.set(blobKey, Buffer.from(JSON.stringify(payload)));
    parent = entryId;
  }
  for (const k of keys.slice(n)) objects.objects.set(k, Buffer.from("x"));
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

/** `@name`: a key in the thread's own tree, resolved by `thread()`; `named(name)` reads it back. */
const key = (name: string) => `@${name}`;
const resolved = new Map<string, string>();
const named = (name: string): string => {
  const k = resolved.get(name);
  if (k === undefined) throw new Error(`no blob named ${name}`);
  return k;
};

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
  h.mailer.sent.length = 0;
});

/**
 * A tick whose lock connection failed releases it as broken: the pool closes the socket without
 * waiting, so the backend (and its session advisory lock) can outlive the tick by a moment. Wait
 * until none is held, so the next test never sees "busy" from a predecessor.
 */
afterEach(async () => {
  await expect
    .poll(
      async () =>
        (
          await h.admin.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_locks
             WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          )
        ).rows[0]?.n,
      { timeout: 10_000 },
    )
    .toBe("0");
});

describe("retention settings (D6, D8; 7-day grace: user decision 2026-10-04)", () => {
  it("defaults to forever; members read it, only team admins change it, within the install maximum", async () => {
    const read = await as.bob.get("/v1/team/retention");
    expect(read.json).toEqual({
      period: "forever",
      maximum: "forever",
      effective: "forever",
      pending: null,
      upcoming: null,
      allowed: ["30d", "90d", "1y", "forever"],
    });
    expect((await as.bob.put("/v1/team/retention", { period: "30d" })).status).toBe(403);
    expect((await as.bob.delete("/v1/team/retention/pending")).status).toBe(403);
    expect((await as.alice.put("/v1/team/retention", { period: "7d" })).status).toBe(400);
    expect((await as.alice.put("/v1/install/retention", { maximum: "90d" })).status).toBe(403);
  });

  it("schedules a shortening 7 days out: banner for members, email to admins (count only), cancellable", async () => {
    await thread({ owner: ids.bob, title: "Secret plan", activity: ago(400) });
    await thread({ owner: ids.carol, title: "Other secret", activity: ago(380) });
    await thread({ owner: ids.carol, title: "Recent", activity: ago(5) });
    // In Trash: not counted (Trash empties itself after 30 days anyway).
    await thread({ owner: ids.carol, title: "Trashed", activity: ago(390), deletedAt: ago(1) });
    h.mailer.sent.length = 0;
    const before = Date.now();
    const set = await as.alice.put("/v1/team/retention", { period: "1y" });
    expect(set.status).toBe(200);
    const effectiveAt = new Date(String(set.json.pending?.effectiveAt)).getTime();
    expect(effectiveAt - before).toBeGreaterThanOrEqual(7 * DAY - 1000);
    expect(effectiveAt - before).toBeLessThanOrEqual(7 * DAY + 60_000);
    // Not in force yet: the job still keeps everything.
    expect(set.json).toMatchObject({ period: "1y", effective: "forever" });
    const banner = (await as.bob.get("/v1/team/retention")).json;
    expect(banner.upcoming).toEqual({ period: "1y", effectiveAt: set.json.pending.effectiveAt });
    await pass();
    expect(await threadIds()).toHaveLength(4);

    expect((await audits("retention.policy.changed")).at(-1)).toMatchObject({
      actor_id: ids.alice,
      target: { period: "1y", previous: "forever", effectiveAt: set.json.pending.effectiveAt },
    });
    await h.mailer.settle();
    const [mail, ...more] = h.mailer.to("alice@ret.test");
    expect(more).toEqual([]);
    expect(mail?.subject).toMatch(/conversations older than 1 year will be deleted/);
    expect(mail?.text).toContain("Today, 2 conversations in the team would be deleted");
    expect(mail?.text).toContain("not counting conversations in Trash");
    expect(mail?.text).not.toMatch(/Secret plan|Other secret|Recent|Trashed/);
    expect(h.mailer.to("bob@ret.test")).toEqual([]);
    expect((await audits("retention.shortening_notified")).at(-1)?.target).toMatchObject({
      period: "1y",
      threads: 2,
      recipients: 1,
    });

    // Cancel during the grace period: reverts to what applies, audited.
    const cancelled = await as.alice.delete("/v1/team/retention/pending");
    expect(cancelled.json).toMatchObject({ period: "forever", pending: null, upcoming: null });
    expect((await audits("retention.policy.change_cancelled")).at(-1)).toMatchObject({
      actor_id: ids.alice,
      target: { period: "1y", kept: "forever" },
    });
    expect((await as.alice.delete("/v1/team/retention/pending")).status).toBe(404);
  });

  it("applies the shortening once its date has come; lengthening applies at once", async () => {
    const old = await thread({ owner: ids.bob, activity: ago(40) });
    await as.alice.put("/v1/team/retention", { period: "30d" });
    // The grace period ends (as if 7 days passed).
    await h.admin.query(`UPDATE team_retention SET pending_at = now() - interval '1 minute'`);
    expect((await as.bob.get("/v1/team/retention")).json).toMatchObject({
      period: "30d",
      effective: "30d",
      pending: null,
    });
    await pass();
    expect(await threadIds()).not.toContain(old);
    // Longer: no grace, no email.
    h.mailer.sent.length = 0;
    const longer = await as.alice.put("/v1/team/retention", { period: "1y" });
    expect(longer.json).toMatchObject({ period: "1y", effective: "1y", pending: null });
    await h.mailer.settle();
    expect(h.mailer.sent).toEqual([]);
    expect((await audits("retention.policy.changed")).at(-1)?.target).toEqual({
      period: "1y",
      previous: "30d",
    });
  });

  it("lowers the install maximum after the grace period, emailing the teams it shortens; cancellable", async () => {
    await setPeriod(other, "30d");
    h.mailer.sent.length = 0;
    const max = await as.owner.put("/v1/install/retention", { maximum: "90d" });
    expect(max.json).toMatchObject({
      maximum: "90d",
      applied: "forever",
      pending: { maximum: "90d" },
    });
    expect((await audits("retention.maximum.changed", null)).at(-1)?.target).toMatchObject({
      maximum: "90d",
      previous: "forever",
      effectiveAt: max.json.pending.effectiveAt,
    });
    // Finance (forever) is shortened, so its admin is told; Legal (30 days) is not affected.
    const view = (await as.bob.get("/v1/team/retention")).json;
    expect(view).toMatchObject({
      period: "forever",
      maximum: "90d",
      effective: "forever",
      upcoming: { period: "90d", effectiveAt: max.json.pending.effectiveAt },
      allowed: ["30d", "90d"],
    });
    await h.mailer.settle();
    expect(h.mailer.to("alice@ret.test")).toHaveLength(1);
    expect((await audits("retention.shortening_notified", other)).length).toBe(0);
    // A team can't choose above the coming maximum.
    const over = await as.alice.put("/v1/team/retention", { period: "1y" });
    expect(over.status).toBe(409);
    expect(over.json.code).toBe("exceeds_maximum");

    const cancelled = await as.owner.delete("/v1/install/retention/pending");
    expect(cancelled.json).toEqual({ maximum: "forever", applied: "forever", pending: null });
    expect((await audits("retention.maximum.change_cancelled", null)).at(-1)?.target).toEqual({
      maximum: "90d",
      kept: "forever",
    });
    expect((await as.bob.get("/v1/team/retention")).json.upcoming).toBeNull();
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
    // A fork of the old thread shares its object (dedup): the object must survive the purge.
    const fresh = await thread({
      owner: ids.bob,
      activity: ago(10),
      blobKeys: [key("fresh"), named("shared")],
    });
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
    // Another team: forever (default), same age: untouched.
    const elsewhere = await thread({ teamId: other, owner: ids.bob, activity: ago(400) });

    const result = await pass();

    expect(await threadIds()).toEqual([fresh, trashedRecently, busy].sort());
    expect(await threadIds(other)).toEqual([elsewhere]);
    expect(objects.deleted.sort()).toEqual([named("old-1"), named("trash-1")].sort());
    expect(objects.keys().sort()).toEqual([named("fresh"), named("shared")].sort());
    const mine = result.teams.find((t) => t.teamId === team);
    expect(mine).toMatchObject({
      trash: { threads: 1, entries: 2, blobs: 1 },
      retention: { threads: 1, entries: 2, blobs: 2 },
      blobs: { blobs: 2, kept: 1 },
      failed: false,
    });
    // Audited as counts only, by the system.
    const purged = (await audits("retention.purged")).slice(-2);
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

  it("deletes only keys in the purged thread's own tree, never anything a crafted reference names", async () => {
    await setPeriod(team, "30d");
    const victim = await thread({ owner: ids.carol, blobKeys: [key("victim")] });
    const foreign = `${PREFIX}teams/${other}/uploads/x`;
    const workspace = `${PREFIX}teams/${team}/users/${ids.bob}/workspace/${"b".repeat(64)}`;
    const upload = `${PREFIX}teams/${team}/uploads/carols-file`;
    const outside = `elsewhere/${team}/x`;
    const crafted = [foreign, workspace, upload, outside];
    for (const k of crafted) objects.objects.set(k, Buffer.from("x"));
    // Bob's thread points at Carol's thread's object and at objects outside any thread tree.
    await thread({
      owner: ids.bob,
      activity: ago(40),
      blobKeys: [named("victim"), ...crafted],
      entries: 5,
    });
    await h.admin.query(
      `UPDATE thread_entries SET blob_ref = NULL WHERE team_id = $1 AND thread_id = $2`,
      [team, victim],
    );
    await pass();
    expect(objects.deleted).toEqual([]);
    expect(objects.keys().sort()).toEqual([...crafted, named("victim")].sort());
    // Bob's thread went; Carol's stays (recent activity).
    expect(await threadIds()).toEqual([victim]);
  });

  it("re-reads the period in every batch: a lengthening mid-pass stops the purge", async () => {
    await setPeriod(team, "30d");
    for (let i = 0; i < 3; i++) await thread({ owner: ids.bob, activity: ago(40 + i) });
    let batches = 0;
    const outcome = await purgeThreads(
      h.deps.database.db,
      team,
      { kind: "retention" },
      async () => {
        batches += 1;
        // An admin lengthens the period while the first batch runs (committed before the next).
        if (batches === 1) await setPeriod(team, "1y");
      },
      { limits: { threads: 1, entries: 1000 } },
    );
    expect(outcome.counts.threads).toBe(1);
    expect(await threadIds()).toHaveLength(2);
  });

  it("keeps Trash its full 30 days and restarts the period on restore (review H1)", async () => {
    await setPeriod(team, "30d");
    // Idle 25 days when trashed, 6 days ago: past the period now, but Trash keeps it 30 days.
    const trashed = await thread({ owner: ids.bob, activity: ago(31), deletedAt: ago(6) });
    // Idle 29 days and in Trash: restored, it must not be purged at the next pass.
    const restored = await thread({ owner: ids.bob, activity: ago(29), deletedAt: ago(1) });
    expect((await as.bob.post(`/v1/threads/${restored}/restore`)).status).toBe(200);
    // Simulate the next nights: two days later the restored thread is still well inside 30 days.
    await h.admin.query(
      `UPDATE threads SET last_activity_at = last_activity_at - interval '2 days'
        WHERE team_id = $1 AND id = $2`,
      [team, restored],
    );
    await pass();
    expect(await threadIds()).toEqual([trashed, restored].sort());
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
    expect(objects.keys()).toEqual([named("held")]);
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
    expect(objects.keys()).toEqual([named("late")]);
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
    const carols = await thread({
      owner: ids.carol,
      title: "Carol secret",
      blobKeys: [key("carol-secret")],
    });
    const mine = await thread({ owner: ids.bob, title: "Budget 2027", entries: 4 });
    const trashed = await thread({ owner: ids.bob, title: "Old plan", deletedAt: ago(2) });
    // Its second entry names Carol's object: never read (not in this thread's tree).
    const offloaded = await thread({
      owner: ids.bob,
      title: "Big",
      blobKeys: [key("big"), named("carol-secret")],
    });
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
    expect(JSON.parse(big[2] ?? "{}")).toEqual({
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: expect.any(String),
      kobe_unavailable: true,
    });

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

describe("pass interruptions (review M3, L2, L6)", () => {
  const job = (pool: { connect: () => Promise<PoolClient> }, now?: Date) =>
    new RetentionJob({
      db: h.deps.database.db,
      pool,
      blobs,
      hourUtc: 3,
      logger: log,
      ...(now ? { now: () => now } : {}),
    });

  it("stops the pass when the lock connection fails, without crashing, and resumes on the next check", async () => {
    await setPeriod(team, "30d");
    const old = await thread({ owner: ids.bob, activity: ago(40) });
    let lockClient: PoolClient | undefined;
    const failing = {
      connect: async () => {
        const client = await h.deps.database.pool.connect();
        lockClient = client;
        // The connection drops right after the lock is taken (failover, idle kill).
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          const result = await query(...args);
          if (String(args[0]).includes("pg_try_advisory_lock")) {
            client.emit("error", new Error("terminating connection due to administrator command"));
          }
          return result;
        };
        return client;
      },
    };
    expect(await job(failing).tick(true)).toBe("lost");
    expect(lockClient).toBeDefined();
    // Nothing was purged and the pass stays open: the next check resumes it, even outside the hour.
    expect(await threadIds()).toEqual([old]);
    const cursor = await h.admin.query<{ value: string }>(
      `SELECT value FROM install_settings WHERE key = 'retention.cursor'`,
    );
    expect(cursor.rows[0]?.value).toBe("start");
    expect(await job(h.deps.database.pool, new Date("2026-10-05T12:00:00Z")).tick()).toBe("ran");
    expect(await threadIds()).toEqual([]);
  });

  it("resumes an unfinished pass after the last team done, not from the start", async () => {
    await setPeriod(team, "30d");
    await setPeriod(other, "30d");
    const first = team < other ? team : other;
    const second = team < other ? other : team;
    const a = await thread({ teamId: first, owner: ids.bob, activity: ago(40) });
    const b = await thread({ teamId: second, owner: ids.bob, activity: ago(40) });
    // A pass crashed after finishing `first` (whose thread then came back, e.g. a restore).
    await h.admin.query(
      `INSERT INTO install_settings (key, value) VALUES ('retention.cursor', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [first],
    );
    expect(await job(h.deps.database.pool, new Date("2026-10-05T12:00:00Z")).tick()).toBe("ran");
    expect(await threadIds(first)).toEqual([a]);
    expect(await threadIds(second)).toEqual([]);
    expect(b).toBeTruthy();
    const settings = await h.admin.query<{ key: string; value: string }>(
      `SELECT key, value FROM install_settings WHERE key IN ('retention.cursor', 'retention.last_pass_at')`,
    );
    expect(Object.fromEntries(settings.rows.map((r) => [r.key, r.value]))).toMatchObject({
      "retention.cursor": "",
      "retention.last_pass_at": expect.any(String),
    });
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
