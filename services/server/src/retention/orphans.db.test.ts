import { createHash, randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "../audit/context.js";
import { createTeamWithAdmin } from "../teams/members.js";
import { openHarness, type Harness } from "../testing/harness.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import type { BlobStore } from "./blobs.js";
import { ORPHAN_GRACE_MS, sweepOrphanObjects } from "./orphans.js";
import { runRetentionPass } from "./job.js";

/** KOBE-189: the orphaned object sweep against a real Postgres and an in-memory bucket. */
let h: Harness;
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const store: BlobStore = { objects, prefix: PREFIX };
let team = "";
let user = "";
let admin = "";
let member = "";
const DAY = 86_400_000;
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

const staging = (teamId = team, userId = user, prefix = PREFIX) =>
  `${prefix}teams/${teamId}/users/${userId}/workspace/incoming/${randomUUID()}`;
const forkKey = (threadId = randomUUID(), teamId = team, prefix = PREFIX) =>
  `${prefix}teams/${teamId}/threads/${threadId}/entries/${hex(randomUUID())}`;

/** Puts an object that is `ageMs` old. */
function put(key: string, ageMs: number): string {
  objects.objects.set(key, Buffer.from("x"));
  objects.age(key, ageMs);
  return key;
}
const sweep = () => sweepOrphanObjects(h.deps.database.db, team, store);

async function placeHold(userId: string | null): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3)
     RETURNING id`,
    [team, userId, admin],
  );
  const id = rows[0]?.id ?? "";
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    user,
  ]);
  return id;
}

beforeAll(async () => {
  h = await openHarness({ blobs: store });
  user = await h.createUser("owner@orphans.test", "owner");
  admin = await h.createUser("admin@orphans.test", "admin");
  member = await h.createUser("member@orphans.test");
  team = (
    await runWithAuditContext(
      { actor: { kind: "user", id: user }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug: "orphans", name: "orphans" }, user),
    )
  ).id;
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, member],
  );
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  objects.objects.clear();
  objects.modified.clear();
  objects.deleted.length = 0;
  await h.admin.query(`DELETE FROM legal_holds`);
  await h.admin.query(`DELETE FROM workspace_files`);
  await h.admin.query(`DELETE FROM retention_blob_deletions`);
  await h.admin.query(`DELETE FROM threads WHERE team_id = $1`, [team]);
});

describe("staging objects", () => {
  it("deletes an old one and keeps a young one", async () => {
    const orphan = put(staging(), ORPHAN_GRACE_MS + 60_000);
    const young = put(staging(), ORPHAN_GRACE_MS - 60_000);
    expect(await sweep()).toEqual({ staging: 1, forks: 0 });
    expect(objects.keys()).toEqual([young]);
    expect(objects.deleted).toEqual([orphan]);
    expect(await sweep()).toEqual({ staging: 0, forks: 0 });
  });

  it("keeps one a row references", async () => {
    const key = put(staging(), 3 * DAY);
    await h.admin.query(
      `INSERT INTO workspace_files (team_id, user_id, path, rev, sha256, blob_key, size, mtime_ms, origin)
       VALUES ($1, $2, 'a.txt', 1, $3, $4, 1, 1, 'server')`,
      [team, user, hex("a"), key],
    );
    expect(await sweep()).toEqual({ staging: 0, forks: 0 });
    expect(objects.keys()).toEqual([key]);
  });

  it("keeps the owner's under a hold, and everything under a team-wide hold", async () => {
    const key = put(staging(team, member), 3 * DAY);
    await placeHold(member);
    expect((await sweep()).staging).toBe(0);
    await h.admin.query(`DELETE FROM legal_holds`);
    await placeHold(null);
    expect((await sweep()).staging).toBe(0);
    expect(objects.keys()).toEqual([key]);
    await h.admin.query(`DELETE FROM legal_holds`);
    expect((await sweep()).staging).toBe(1);
  });

  it("ignores other shapes under incoming/ and other teams", async () => {
    const odd = put(`${PREFIX}teams/${team}/users/${user}/workspace/incoming/not-a-uuid`, 3 * DAY);
    const content = put(`${PREFIX}teams/${team}/users/${user}/workspace/${hex("c")}`, 3 * DAY);
    const foreign = put(staging(randomUUID(), user), 3 * DAY);
    expect(await sweep()).toEqual({ staging: 0, forks: 0 });
    expect(objects.keys().sort()).toEqual([odd, content, foreign].sort());
  });
});

describe("fork-copied entry bodies", () => {
  it("deletes bodies of a thread without a row once old, keeps young ones", async () => {
    const id = randomUUID();
    const orphan = put(forkKey(id), 2 * DAY);
    const young = put(forkKey(id), 60_000);
    expect(await sweep()).toEqual({ staging: 0, forks: 1 });
    expect(objects.keys()).toEqual([young]);
    expect(objects.deleted).toEqual([orphan]);
  });

  it("keeps bodies of a thread that has a row", async () => {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 't')`,
      [team, id, user],
    );
    const key = put(forkKey(id), 3 * DAY);
    expect((await sweep()).forks).toBe(0);
    expect(objects.keys()).toEqual([key]);
  });

  it("keeps bodies queued for release and other object kinds in the tree", async () => {
    const id = randomUUID();
    const queued = put(forkKey(id), 3 * DAY);
    await h.admin.query(
      `INSERT INTO retention_blob_deletions (team_id, thread_id, key, owner_user_id) VALUES ($1, $2, $3, $4)`,
      [team, id, queued, user],
    );
    const artifact = put(`${PREFIX}teams/${team}/threads/${id}/artifacts/${hex("z")}`, 3 * DAY);
    expect((await sweep()).forks).toBe(0);
    expect(objects.keys().sort()).toEqual([queued, artifact].sort());
  });

  it("keeps everything while any hold is active in the team", async () => {
    const key = put(forkKey(), 3 * DAY);
    await placeHold(null);
    expect((await sweep()).forks).toBe(0);
    expect(objects.keys()).toEqual([key]);
  });
});

describe("boundaries and limits", () => {
  it("never lists or deletes outside the configured prefix", async () => {
    const id = randomUUID();
    const outside = [
      put(staging(team, user, "other/"), 3 * DAY),
      put(staging(team, user, ""), 3 * DAY),
      put(forkKey(id, team, "other/"), 3 * DAY),
      put(forkKey(id, team, ""), 3 * DAY),
    ];
    const inside = put(forkKey(id), 3 * DAY);
    expect((await sweep()).forks).toBe(1);
    expect(objects.keys().sort()).toEqual(outside.sort());
    expect(objects.deleted).toEqual([inside]);
  });

  it("caps deletions per sweep and finishes on the next", async () => {
    for (let i = 0; i < 5; i++) put(staging(), 3 * DAY);
    const db = h.deps.database.db;
    expect(await sweepOrphanObjects(db, team, store, { maxDeletions: 2 })).toEqual({
      staging: 2,
      forks: 0,
    });
    expect(objects.keys()).toHaveLength(3);
    await sweepOrphanObjects(db, team, store, { maxDeletions: 10 });
    expect(objects.keys()).toEqual([]);
  });

  it("runs as a step of the retention pass, with counts only in its result", async () => {
    put(staging(), 3 * DAY);
    const res = await runRetentionPass({
      db: h.deps.database.db,
      blobs: store,
      logger: pino({ level: "silent" }),
    });
    expect(res.teams.find((t) => t.teamId === team)?.orphans).toEqual({ staging: 1, forks: 0 });
    expect(objects.keys()).toEqual([]);
  });
});
