import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { collectWorkspace, workspaceBlobKey } from "./workspace-sync/index.js";
import { collectAll, type CollectOptions } from "./workspace-sync/gc.js";
import { purgeDeparted } from "./offboarding/purge.js";
import type { OffboardingContext } from "./offboarding/types.js";

/**
 * Workspace blob collection under a legal hold (KOBE-183): the held (team, user)'s blobs, objects
 * and tombstones stay; others' go; a hold placed while a sweep runs wins (the sweep re-checks under
 * the shared legal-hold lock before it deletes anything).
 */
const fx = new EventStreamFixture();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const OPTIONS: CollectOptions = {
  prefix: "",
  blobGraceMs: 0,
  tombstoneTtlMs: 1000,
  batch: 10,
  budgetMs: 5000,
};

beforeAll(() => fx.setup([{}]));
afterAll(() => fx.teardown());

interface Ws {
  readonly teamId: string;
  readonly userId: string;
  readonly owner: { teamId: string; userId: string };
  readonly keys: string[];
}

/** A workspace with two released blobs (objects stored) and one old tombstone. */
async function workspace(objects: MemoryObjects, teamId: string, person: Person): Promise<Ws> {
  const owner = { teamId, userId: person.id };
  const keys: string[] = [];
  await fx.admin.query(
    `INSERT INTO workspace_sync (team_id, user_id, head_rev, tombstones, blob_count, blob_bytes)
     VALUES ($1, $2, 1, 1, 2, 2) ON CONFLICT DO NOTHING`,
    [teamId, person.id],
  );
  for (const content of [`a-${person.id}`, `b-${person.id}`]) {
    await fx.admin.query(
      `INSERT INTO workspace_blobs (team_id, user_id, sha256, size, created_at, released_at)
       VALUES ($1, $2, $3, 1, now() - interval '2 days', now() - interval '1 day')`,
      [teamId, person.id, sha(content)],
    );
    const key = workspaceBlobKey("", owner, sha(content));
    await objects.put(key, Readable.from([Buffer.from("x")]), 1);
    keys.push(key);
  }
  await fx.admin.query(
    `INSERT INTO workspace_files (team_id, user_id, path, rev, deleted, size, mtime_ms, origin, updated_at)
     VALUES ($1, $2, 'gone.txt', 1, true, 0, 0, 'sandbox', now() - interval '2 days')`,
    [teamId, person.id],
  );
  return { teamId, userId: person.id, owner, keys };
}

async function counts(w: Ws) {
  const q = (t: string, extra = "") =>
    fx.admin
      .query<{ n: string }>(
        `SELECT count(*) AS n FROM ${t} WHERE team_id = $1 AND user_id = $2 ${extra}`,
        [w.teamId, w.userId],
      )
      .then((r) => Number(r.rows[0]?.n));
  return {
    blobs: await q("workspace_blobs"),
    marked: await q("workspace_blobs", "AND deleting"),
    tombstones: await q("workspace_files"),
  };
}

/** The two-person flow is covered in KOBE-17; the guard trigger is bypassed to get a hold row. */
async function hold(c: pg.Client, teamId: string, userId: string | null, by: string) {
  await c.query("SET session_replication_role = replica");
  try {
    await c.query(
      `INSERT INTO legal_holds (team_id, user_id, reason, status, placed_by, approved_by, approved_at, self_approved)
       VALUES ($1, $2, 'matter', 'active', $3, $3, now(), true)`,
      [teamId, userId, by],
    );
  } finally {
    await c.query("SET session_replication_role = DEFAULT");
  }
}
async function release(teamId: string) {
  await fx.admin.query("SET session_replication_role = replica");
  try {
    await fx.admin.query(
      `UPDATE legal_holds SET status = 'released', release_requested_by = placed_by, release_requested_at = now(),
              release_reason = 'done', released_by = placed_by, released_at = now(), release_self_approved = true
        WHERE team_id = $1 AND status = 'active'`,
      [teamId],
    );
  } finally {
    await fx.admin.query("SET session_replication_role = DEFAULT");
  }
}

async function setup() {
  const admin = await fx.person(`gh${randomBytes(2).toString("hex")}`);
  const heldUser = await fx.person(`hu${randomBytes(2).toString("hex")}`);
  const other = await fx.person(`ot${randomBytes(2).toString("hex")}`);
  const teamId = await fx.team(`gc-${randomBytes(3).toString("hex")}`, admin, [heldUser, other]);
  const objects = new MemoryObjects();
  return {
    admin,
    teamId,
    objects,
    held: await workspace(objects, teamId, heldUser),
    free: await workspace(objects, teamId, other),
  };
}

describe("workspace blob collection and legal holds", () => {
  it("keeps the held user's blobs, objects and tombstones; collects the others'", async () => {
    const s = await setup();
    await hold(fx.admin, s.teamId, s.held.userId, s.admin.id);
    const total = await collectAll(fx.db, s.objects, OPTIONS, silent);
    expect(total.blobs).toBeGreaterThanOrEqual(2);

    expect(await counts(s.held)).toEqual({ blobs: 2, marked: 0, tombstones: 1 });
    for (const key of s.held.keys) expect(s.objects.objects.has(key)).toBe(true);
    expect(await counts(s.free)).toEqual({ blobs: 0, marked: 0, tombstones: 0 });
    for (const key of s.free.keys) expect(s.objects.objects.has(key)).toBe(false);
  });

  it("a direct collection of a held workspace deletes nothing (quota-pressure path)", async () => {
    const s = await setup();
    await hold(fx.admin, s.teamId, s.held.userId, s.admin.id);
    const r = await collectWorkspace(fx.db, s.objects, s.held.owner, OPTIONS);
    expect(r).toEqual({ blobs: 0, bytes: 0, tombstones: 0 });
    expect(s.objects.deleted).toEqual([]);
    expect(await counts(s.held)).toEqual({ blobs: 2, marked: 0, tombstones: 1 });
  });

  it("a team-wide hold keeps every member's workspace, and only that team's", async () => {
    const s = await setup();
    const t = await setup();
    await hold(fx.admin, s.teamId, null, s.admin.id);
    await collectAll(fx.db, new MemoryObjectsShared(s.objects, t.objects), OPTIONS, silent);
    for (const w of [s.held, s.free]) expect(await counts(w)).toMatchObject({ blobs: 2 });
    for (const w of [t.held, t.free]) expect(await counts(w)).toMatchObject({ blobs: 0 });
    expect(s.objects.keys()).toHaveLength(4);
    expect(t.objects.keys()).toHaveLength(0);
  });

  it("collects the content once the hold is released", async () => {
    const s = await setup();
    await hold(fx.admin, s.teamId, s.held.userId, s.admin.id);
    await collectWorkspace(fx.db, s.objects, s.held.owner, OPTIONS);
    expect(await counts(s.held)).toMatchObject({ blobs: 2 });
    await release(s.teamId);
    await collectWorkspace(fx.db, s.objects, s.held.owner, OPTIONS);
    expect(await counts(s.held)).toEqual({ blobs: 0, marked: 0, tombstones: 0 });
    expect(s.objects.keys()).toHaveLength(2); // only the other user's remain
  });

  it("a hold placed while the sweep waits for the legal-hold lock wins", async () => {
    const s = await setup();
    const approver = new pg.Client({ connectionString: fx.database.adminUrl });
    await approver.connect();
    try {
      await approver.query("BEGIN");
      // What approving a hold does first (KOBE-17 guard): the exclusive lock.
      await approver.query("SELECT pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0))");
      const sweep = collectWorkspace(fx.db, s.objects, s.held.owner, OPTIONS);
      await new Promise((r) => setTimeout(r, 300));
      await hold(approver, s.teamId, s.held.userId, s.admin.id);
      await approver.query("COMMIT");
      await sweep;
    } finally {
      await approver.end();
    }
    expect(s.objects.deleted).toEqual([]);
    expect(await counts(s.held)).toEqual({ blobs: 2, marked: 0, tombstones: 1 });
  });

  it("a hold placed after the batch was marked keeps the objects and unmarks the rows", async () => {
    const s = await setup();
    const r = await collectWorkspace(fx.db, s.objects, s.held.owner, {
      ...OPTIONS,
      afterMark: () => hold(fx.admin, s.teamId, s.held.userId, s.admin.id),
    });
    expect(r.blobs).toBe(0);
    expect(s.objects.deleted).toEqual([]);
    for (const key of s.held.keys) expect(s.objects.objects.has(key)).toBe(true);
    // Rows are available again (not "deleting"), so the held user's uploads and commits work.
    expect(await counts(s.held)).toMatchObject({ blobs: 2, marked: 0 });
  });

  it("an approval waits for a batch that is deleting objects, and then sees the sweep done", async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const inDelete = new Promise<void>((r) => (started = r));
    const slow = new MemoryObjects();
    for (const [k, v] of s.objects.objects) slow.objects.set(k, v);
    const del = slow.delete.bind(slow);
    slow.delete = async (keys) => {
      started();
      await gate;
      return del(keys);
    };
    const sweep = collectWorkspace(fx.db, slow, s.free.owner, OPTIONS);
    await inDelete;
    const approver = new pg.Client({ connectionString: fx.database.adminUrl });
    await approver.connect();
    try {
      await approver.query("BEGIN");
      let locked = false;
      const lock = approver
        .query("SELECT pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0))")
        .then(() => (locked = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(locked).toBe(false); // the batch holds the lock shared
      release();
      await sweep;
      await lock;
      await approver.query("COMMIT");
    } finally {
      await approver.end();
    }
    expect(await counts(s.free)).toMatchObject({ blobs: 0 });
  });
});

describe("offboarding purge and legal holds (KOBE-28 path, re-verified by KOBE-183)", () => {
  /** A destroyed sandbox past its retention, one live file and its blob in the member's tree. */
  async function departed(objects: MemoryObjects, teamId: string, person: Person) {
    const owner = { teamId, userId: person.id };
    const content = `live-${person.id}`;
    const key = workspaceBlobKey("", owner, sha(content));
    await objects.put(key, Readable.from([Buffer.from("x")]), 1);
    await fx.admin.query(
      `INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, retain_until)
       VALUES ($1, $2, gen_random_uuid(), 'destroyed', now() - interval '1 minute')`,
      [teamId, person.id],
    );
    await fx.admin.query(
      `INSERT INTO workspace_sync (team_id, user_id, head_rev, live_files, live_bytes, blob_count, blob_bytes)
       VALUES ($1, $2, 1, 1, 1, 1, 1) ON CONFLICT DO NOTHING`,
      [teamId, person.id],
    );
    await fx.admin.query(
      `INSERT INTO workspace_blobs (team_id, user_id, sha256, size) VALUES ($1, $2, $3, 1)`,
      [teamId, person.id, sha(content)],
    );
    await fx.admin.query(
      `INSERT INTO workspace_files (team_id, user_id, path, rev, sha256, blob_key, size, mtime_ms, origin)
       VALUES ($1, $2, 'f.txt', 1, $3, $4, 1, 0, 'sandbox')`,
      [teamId, person.id, sha(content), key],
    );
    return { owner, key };
  }
  const ctxFor = (objects: MemoryObjects): OffboardingContext => ({
    db: fx.db,
    provider: () => undefined,
    blobs: { objects, prefix: "" },
    log: silent as unknown as OffboardingContext["log"],
  });
  const rows = (o: { teamId: string; userId: string }) =>
    fx.admin
      .query<{ f: string; b: string }>(
        `SELECT (SELECT count(*) FROM workspace_files WHERE team_id = $1 AND user_id = $2) AS f,
                (SELECT count(*) FROM workspace_blobs WHERE team_id = $1 AND user_id = $2) AS b`,
        [o.teamId, o.userId],
      )
      .then((r) => [Number(r.rows[0]?.f), Number(r.rows[0]?.b)]);

  it("purges the unheld member's objects and rows, keeps the held member's", async () => {
    const admin = await fx.person(`pa${randomBytes(2).toString("hex")}`);
    const a = await fx.person(`pb${randomBytes(2).toString("hex")}`);
    const b = await fx.person(`pc${randomBytes(2).toString("hex")}`);
    const teamId = await fx.team(`op-${randomBytes(3).toString("hex")}`, admin, [a, b]);
    const objects = new MemoryObjects();
    const held = await departed(objects, teamId, a);
    const free = await departed(objects, teamId, b);
    await hold(fx.admin, teamId, a.id, admin.id);

    expect(await purgeDeparted(ctxFor(objects), held.owner)).toBe("held");
    expect(await purgeDeparted(ctxFor(objects), free.owner)).toBe("deleted");
    expect(objects.objects.has(held.key)).toBe(true);
    expect(await rows(held.owner)).toEqual([1, 1]);
    expect(objects.objects.has(free.key)).toBe(false);
    expect(await rows(free.owner)).toEqual([0, 0]);
  });

  it("a team-wide hold keeps every member's copy", async () => {
    const admin = await fx.person(`pd${randomBytes(2).toString("hex")}`);
    const a = await fx.person(`pe${randomBytes(2).toString("hex")}`);
    const teamId = await fx.team(`ot-${randomBytes(3).toString("hex")}`, admin, [a]);
    const objects = new MemoryObjects();
    const w = await departed(objects, teamId, a);
    await hold(fx.admin, teamId, null, admin.id);
    expect(await purgeDeparted(ctxFor(objects), w.owner)).toBe("held");
    expect(objects.objects.has(w.key)).toBe(true);
    expect(await rows(w.owner)).toEqual([1, 1]);
  });

  it("a hold placed while the purge waits for the legal-hold lock wins", async () => {
    const admin = await fx.person(`pf${randomBytes(2).toString("hex")}`);
    const a = await fx.person(`pg${randomBytes(2).toString("hex")}`);
    const teamId = await fx.team(`ow-${randomBytes(3).toString("hex")}`, admin, [a]);
    const objects = new MemoryObjects();
    const w = await departed(objects, teamId, a);
    const approver = new pg.Client({ connectionString: fx.database.adminUrl });
    await approver.connect();
    try {
      await approver.query("BEGIN");
      await approver.query("SELECT pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0))");
      const purge = purgeDeparted(ctxFor(objects), w.owner);
      await new Promise((r) => setTimeout(r, 300));
      await hold(approver, teamId, a.id, admin.id);
      await approver.query("COMMIT");
      expect(await purge).toBe("held");
    } finally {
      await approver.end();
    }
    expect(objects.deleted).toEqual([]);
    expect(await rows(w.owner)).toEqual([1, 1]);
  });
});

/** Routes each key to the store of the team it belongs to (two fixtures, one collection pass). */
class MemoryObjectsShared extends MemoryObjects {
  constructor(
    private readonly a: MemoryObjects,
    private readonly b: MemoryObjects,
  ) {
    super();
  }
  override delete(keys: readonly string[]): Promise<void> {
    for (const store of [this.a, this.b]) {
      void store.delete(keys.filter((k) => store.objects.has(k)));
    }
    return Promise.resolve();
  }
}
