import { randomUUID } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memoryBlobKey } from "./memory/keys.js";
import { purgeDeparted } from "./offboarding/purge.js";
import { runRetentionPass, type BlobStore } from "./retention/index.js";
import { runWithAuditContext } from "./audit/context.js";
import { createTeamWithAdmin } from "./teams/members.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-188 (D24 "memory follows team retention", user decision 2026-10-09): the retention pass
 * purges superseded versions and long-soft-deleted docs after the team's window, never a live doc;
 * the offboarding purge removes a departed member's personal memory. Legal hold always wins.
 */
let h: Harness;
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs: BlobStore = { objects, prefix: PREFIX };
const log = pino({ level: "silent" });
const ids = { owner: "", admin: "", alice: "", bob: "" };
/** Audit rows before the current test (the log is append-only). */
let auditFloor = 0;
let team = "";
let project = "";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const pass = () => runRetentionPass({ db: h.deps.database.db, blobs, logger: log });

interface DocSpec {
  readonly owner?: string;
  readonly path: string;
  /** Age in days of each version, oldest first; the last one is current. */
  readonly versions: readonly number[];
  readonly deletedDaysAgo?: number;
}

/** A memory doc with its versions and their objects (superuser fixture). */
async function doc(spec: DocSpec): Promise<string> {
  const id = randomUUID();
  const personal = spec.owner !== undefined;
  await h.admin.query(
    `INSERT INTO memory_docs (team_id, id, scope, owner_user_id, project_id, path, current_version, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      team,
      id,
      personal ? "user" : "project",
      spec.owner ?? null,
      personal ? null : project,
      spec.path,
      spec.versions.length,
      spec.deletedDaysAgo === undefined ? null : ago(spec.deletedDaysAgo),
    ],
  );
  for (const [i, age] of spec.versions.entries()) {
    const key = memoryBlobKey(PREFIX, team, id, i + 1);
    objects.objects.set(key, Buffer.from(`v${i + 1}`));
    await h.admin.query(
      `INSERT INTO memory_doc_versions (team_id, doc_id, version, blob_ref, size_bytes, sha256, actor_kind, created_at)
       VALUES ($1, $2, $3, $4, 2, $5, 'user', $6)`,
      [team, id, i + 1, key, "a".repeat(64), ago(age)],
    );
  }
  return id;
}

const versionsOf = async (docId: string): Promise<number[]> =>
  (
    await h.admin.query<{ version: number }>(
      `SELECT version FROM memory_doc_versions WHERE doc_id = $1 ORDER BY version`,
      [docId],
    )
  ).rows.map((r) => r.version);
const exists = async (docId: string): Promise<boolean> =>
  (await h.admin.query(`SELECT 1 FROM memory_docs WHERE id = $1`, [docId])).rowCount === 1;
const hasObject = (docId: string, version: number) =>
  objects.objects.has(memoryBlobKey(PREFIX, team, docId, version));

async function audits(action: string) {
  const { rows } = await h.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE action = $1 AND team_id = $2 AND seq > $3 ORDER BY seq`,
    [action, team, auditFloor],
  );
  return rows.map((r) => r.target);
}

async function setPeriod(period: string): Promise<void> {
  await h.admin.query(
    `INSERT INTO team_retention (team_id, period, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (team_id) DO UPDATE SET period = EXCLUDED.period`,
    [team, period, ids.alice],
  );
}

/** Releases the team's active holds (request and approval, as in the two-person flow). */
async function clearHolds(): Promise<void> {
  const { rows } = await h.admin.query<{ id: string }>(
    `SELECT id FROM legal_holds WHERE team_id = $1 AND status = 'active'`,
    [team],
  );
  for (const { id } of rows) {
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
}

async function placeHold(userId: string | null): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter 188', $3)
     RETURNING id`,
    [team, userId, ids.admin],
  );
  const id = rows[0]?.id ?? "";
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    ids.owner,
  ]);
  return id;
}

beforeAll(async () => {
  h = await openHarness({ blobs });
  ids.owner = await h.createUser("owner@memret.test", "owner");
  ids.admin = await h.createUser("admin@memret.test", "admin");
  ids.alice = await h.createUser("alice@memret.test");
  ids.bob = await h.createUser("bob@memret.test");
  team = (
    await runWithAuditContext(
      { actor: { kind: "user", id: ids.alice }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug: "memret", name: "memret" }, ids.alice),
    )
  ).id;
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, ids.bob],
  );
  project = randomUUID();
  await h.admin.query(
    `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, 'memret', 'M', $3)`,
    [team, project, ids.alice],
  );
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  await h.admin.query(`DELETE FROM team_retention`);
  await clearHolds();
  await h.admin.query(`DELETE FROM memory_docs WHERE team_id = $1`, [team]);
  auditFloor = Number(
    (await h.admin.query<{ n: string }>(`SELECT coalesce(max(seq), 0) AS n FROM audit_log`)).rows[0]
      ?.n,
  );
  await h.admin.query(`DELETE FROM sandboxes WHERE team_id = $1`, [team]);
  objects.objects.clear();
  objects.deleted.length = 0;
});

describe("the retention pass (option b)", () => {
  it("purges superseded versions older than the window, keeps the current one and Undo history inside it", async () => {
    await setPeriod("30d");
    // v1 was superseded 60 days ago, v2 5 days ago, v3 is current.
    const a = await doc({ owner: ids.alice, path: "a.md", versions: [100, 60, 5] });
    const old = await doc({ owner: ids.alice, path: "old.md", versions: [200] });
    await pass();
    expect(await versionsOf(a)).toEqual([2, 3]);
    expect(hasObject(a, 1)).toBe(false);
    expect(hasObject(a, 2) && hasObject(a, 3)).toBe(true);
    // A current version is never purged, however old.
    expect(await versionsOf(old)).toEqual([1]);
    expect(hasObject(old, 1)).toBe(true);
    expect(await audits("retention.memory_purged")).toEqual([
      { reason: "retention", docs: 0, versions: 1, blobs: 1 },
    ]);
  });

  it("purges nothing while the team keeps conversations forever", async () => {
    const a = await doc({ owner: ids.alice, path: "a.md", versions: [400, 300, 5] });
    const gone = await doc({
      owner: ids.alice,
      path: "gone.md",
      versions: [300],
      deletedDaysAgo: 300,
    });
    await pass();
    expect(await versionsOf(a)).toEqual([1, 2, 3]);
    expect(await exists(gone)).toBe(true);
    expect(await audits("retention.memory_purged")).toEqual([]);
  });

  it("purges a soft-deleted doc (rows and all objects) after the window; a live doc never", async () => {
    await setPeriod("90d");
    const gone = await doc({
      owner: ids.alice,
      path: "gone.md",
      versions: [200, 150],
      deletedDaysAgo: 100,
    });
    const recent = await doc({
      owner: ids.alice,
      path: "recent.md",
      versions: [200, 150],
      deletedDaysAgo: 10,
    });
    const live = await doc({ owner: ids.alice, path: "live.md", versions: [400] });
    const proj = await doc({ path: "proj.md", versions: [400, 300], deletedDaysAgo: 120 });
    await pass();
    expect(await exists(gone)).toBe(false);
    expect(await versionsOf(gone)).toEqual([]);
    expect(hasObject(gone, 1) || hasObject(gone, 2)).toBe(false);
    expect(await exists(proj)).toBe(false);
    // Deleted 10 days ago: still restorable; its old v1 (superseded 150 days ago) goes though.
    expect(await exists(recent)).toBe(true);
    expect(await exists(live)).toBe(true);
    expect(hasObject(live, 1)).toBe(true);
    // Two docs (4 versions) plus the superseded v1 of the recently deleted one.
    const events = await audits("retention.memory_purged");
    const sum = (k: "docs" | "versions") => events.reduce((n, e) => n + Number(e[k]), 0);
    expect([sum("docs"), sum("versions")]).toEqual([2, 5]);
  });

  it("leaves a held owner's memory and, with any hold in the team, project memory untouched", async () => {
    await setPeriod("30d");
    await placeHold(ids.bob);
    const bob = await doc({ owner: ids.bob, path: "b.md", versions: [100, 60, 5] });
    const bobGone = await doc({
      owner: ids.bob,
      path: "bg.md",
      versions: [100],
      deletedDaysAgo: 90,
    });
    const proj = await doc({ path: "p.md", versions: [100, 60, 5] });
    const projGone = await doc({ path: "pg.md", versions: [100], deletedDaysAgo: 90 });
    const alice = await doc({ owner: ids.alice, path: "a.md", versions: [100, 60, 5] });
    await pass();
    expect(await versionsOf(bob)).toEqual([1, 2, 3]);
    expect(await exists(bobGone)).toBe(true);
    expect(await versionsOf(proj)).toEqual([1, 2, 3]);
    expect(await exists(projGone)).toBe(true);
    expect(await versionsOf(alice)).toEqual([2, 3]);
  });

  it("a team-wide hold keeps everything", async () => {
    await setPeriod("30d");
    await placeHold(null);
    const alice = await doc({ owner: ids.alice, path: "a.md", versions: [100, 60, 5] });
    const gone = await doc({ owner: ids.alice, path: "g.md", versions: [100], deletedDaysAgo: 90 });
    await pass();
    expect(await versionsOf(alice)).toEqual([1, 2, 3]);
    expect(await exists(gone)).toBe(true);
    expect(objects.deleted).toEqual([]);
  });

  /** An approver transaction holding the legal-hold lock exclusively, like an approval. */
  async function approver() {
    const client = new pg.Client({ connectionString: h.adminUrl });
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0))");
    return client;
  }

  it("a hold approved while the sweep waits for the lock wins", async () => {
    await setPeriod("30d");
    const a = await doc({ owner: ids.alice, path: "a.md", versions: [100, 60, 5] });
    const gone = await doc({ owner: ids.alice, path: "g.md", versions: [100], deletedDaysAgo: 90 });
    const client = await approver();
    const sweep = pass();
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'mid-sweep', $3)
       RETURNING id`,
      [team, ids.alice, ids.admin],
    );
    await client.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
      rows[0]?.id,
      ids.owner,
    ]);
    await client.query("COMMIT");
    await client.end();
    await sweep;
    expect(await versionsOf(a)).toEqual([1, 2, 3]);
    expect(await exists(gone)).toBe(true);
    expect(objects.deleted).toEqual([]);
  });

  it("an approval waits for a batch that is deleting objects", async () => {
    await setPeriod("30d");
    const a = await doc({ owner: ids.alice, path: "a.md", versions: [100, 60, 5] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const inDelete = new Promise<void>((r) => (started = r));
    const slow = new MemoryObjects();
    for (const [k, v] of objects.objects) slow.objects.set(k, v);
    const del = slow.delete.bind(slow);
    slow.delete = async (keys) => {
      started();
      await gate;
      return del(keys);
    };
    const sweep = runRetentionPass({
      db: h.deps.database.db,
      blobs: { objects: slow, prefix: PREFIX },
      logger: log,
    });
    await inDelete;
    const client = new pg.Client({ connectionString: h.adminUrl });
    await client.connect();
    await client.query("BEGIN");
    let locked = false;
    const lock = client
      .query("SELECT pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0))")
      .then(() => (locked = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(locked).toBe(false);
    release();
    // The approval gets the lock once the batch is done; commit it so the pass can go on.
    await lock;
    await client.query("COMMIT");
    await client.end();
    await sweep;
    expect(await versionsOf(a)).toEqual([2, 3]);
  });
});

describe("the offboarding sweep", () => {
  async function departed(userId: string): Promise<void> {
    await h.admin.query(
      `INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, pvc, retain_until)
       VALUES ($1, $2, $3, 'destroyed', NULL, now() - interval '1 minute')`,
      [team, userId, randomUUID()],
    );
  }
  const ctx = () => ({
    db: h.deps.database.db,
    provider: () => undefined,
    blobs,
    log,
  });

  it("purges a departed member's personal memory, never another's nor project memory", async () => {
    const mine = await doc({ owner: ids.bob, path: "b.md", versions: [5, 4] });
    const mineGone = await doc({ owner: ids.bob, path: "bg.md", versions: [5], deletedDaysAgo: 1 });
    const alice = await doc({ owner: ids.alice, path: "a.md", versions: [5, 4] });
    const proj = await doc({ path: "p.md", versions: [5, 4] });
    await departed(ids.bob);
    await expect(purgeDeparted(ctx(), { teamId: team, userId: ids.bob })).resolves.toBe("deleted");
    expect(await exists(mine)).toBe(false);
    expect(await exists(mineGone)).toBe(false);
    expect(hasObject(mine, 1) || hasObject(mine, 2) || hasObject(mineGone, 1)).toBe(false);
    expect(await versionsOf(alice)).toEqual([1, 2]);
    expect(await versionsOf(proj)).toEqual([1, 2]);
    expect(hasObject(alice, 1) && hasObject(proj, 2)).toBe(true);
    expect(await audits("retention.memory_purged")).toEqual([
      { reason: "offboarding", userId: ids.bob, docs: 2, versions: 3, blobs: 3 },
    ]);
  });

  it("keeps everything while a hold covers the member", async () => {
    const mine = await doc({ owner: ids.bob, path: "b.md", versions: [5, 4] });
    await departed(ids.bob);
    await placeHold(ids.bob);
    await expect(purgeDeparted(ctx(), { teamId: team, userId: ids.bob })).resolves.toBe("held");
    expect(await versionsOf(mine)).toEqual([1, 2]);
    expect(hasObject(mine, 2)).toBe(true);
  });
});
