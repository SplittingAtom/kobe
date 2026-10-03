import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKSPACE_SYNC_PATH, type WorkspaceChange } from "@kobe/protocol";
import { sql, withTeam } from "@kobe/db";
import { createSandboxApp } from "./routes/sandbox.js";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandboxAuth } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { KEYS } from "./testing/sandbox-fixtures.js";
import {
  createSandboxAuthenticator,
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceLimits,
  type WorkspaceSync,
} from "./workspace-sync/index.js";
import type { WorkspaceRoutesDeps } from "./workspace-sync/routes.js";

/**
 * Workspace sync under a hostile sandbox (KOBE-27 security review): database in-flight caps and
 * lock timeouts, bounded uncommitted uploads and manifest rows, upload reservations against
 * concurrent PUTs, collection grace from dereference, revocation of cached callers, and commit
 * racing collection. One compromised sandbox must not degrade other tenants.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

beforeAll(() => fx.setup([{}]));
afterAll(() => fx.teardown());

interface Env {
  readonly sync: WorkspaceSync;
  readonly objects: MemoryObjects;
  readonly app: ReturnType<typeof createSandboxApp>;
  readonly authenticate: ReturnType<typeof createSandboxAuthenticator>;
}

function env(
  limits: Partial<WorkspaceLimits> = {},
  dbLimits: WorkspaceRoutesDeps["dbLimits"] = {},
  collect: { blobGraceMs?: number; tombstoneTtlMs?: number; batch?: number } = {},
  objects: MemoryObjects = new MemoryObjects(),
): Env {
  const sync = createWorkspaceSync({
    db: fx.db,
    objects,
    prefix: "",
    limits: { maxFileBytes: 1 << 20, maxWorkspaceBytes: 8 << 20, maxFiles: 1000, ...limits },
    collect: { blobGraceMs: 0, tombstoneTtlMs: 7 * 86_400_000, ...collect },
    dbLimits,
    log: silent,
  });
  const authenticate = createSandboxAuthenticator({
    db: fx.db,
    verify: auth.verify,
    liveness: auth.liveness,
  });
  fx.replica(0).deps.sandboxWire.onUserRevalidate((id) => authenticate.forget(id));
  const app = createSandboxApp({
    provider: { identifyBootstrapToken: () => Promise.reject(new Error("unused")) },
    sessionKeys: KEYS,
    workspace: sync.routes(authenticate),
  });
  return { sync, objects, app, authenticate };
}

interface Box {
  readonly teamId: string;
  readonly person: Person;
  readonly sandboxId: string;
  readonly token: string;
  readonly owner: { teamId: string; userId: string };
}

async function box(person?: Person, teamId?: string): Promise<Box> {
  const p = person ?? (await fx.person(`l${randomBytes(2).toString("hex")}`));
  const t = teamId ?? (await fx.team(`wl-${randomBytes(3).toString("hex")}`, p));
  const sandboxId = randomUUID();
  return {
    teamId: t,
    person: p,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: t, userId: p.id }),
    owner: { teamId: t, userId: p.id },
  };
}

function call(e: Env, b: Box, method: string, path: string, body?: unknown, raw?: Buffer) {
  const headers: Record<string, string> = { authorization: `Bearer ${b.token}` };
  let payload: string | Uint8Array<ArrayBuffer> | undefined;
  if (raw !== undefined) {
    payload = new Uint8Array(raw);
    headers["content-length"] = String(raw.length);
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return e.app.request(`${WORKSPACE_SYNC_PATH}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
}

const upload = (e: Env, b: Box, data: Buffer | string) =>
  call(e, b, "PUT", `/blobs/${sha(data)}`, undefined, Buffer.from(data));

const put = (path: string, data: string, base: number | null = null): WorkspaceChange => ({
  op: "put",
  path,
  base_rev: base,
  sha256: sha(data),
  size: Buffer.byteLength(data),
  mtime_ms: 1,
  executable: false,
});

async function commit(e: Env, b: Box, changes: WorkspaceChange[]) {
  const res = await call(e, b, "POST", "/commit", { changes });
  return {
    status: res.status,
    body: (await res.json()) as {
      results?: { status: string; code?: string; entry?: { rev: number } }[];
    },
  };
}

async function counters(b: Box) {
  const { rows } = await fx.admin.query<{
    live_files: number;
    tombstones: number;
    blob_count: number;
    blob_bytes: string;
    pending_blobs: number;
    rows: string;
  }>(
    `SELECT s.live_files, s.tombstones, s.blob_count, s.blob_bytes, s.pending_blobs,
            (SELECT count(*) FROM workspace_files f WHERE f.team_id = s.team_id AND f.user_id = s.user_id) AS rows
       FROM workspace_sync s WHERE s.team_id = $1 AND s.user_id = $2`,
    [b.teamId, b.person.id],
  );
  return rows[0];
}

describe("database in-flight caps and lock timeouts", () => {
  it("lets one sandbox hold one commit at a time and never wait long on its row lock", async () => {
    const e = env({}, { lockTimeoutMs: 300 });
    const b = await box();
    expect((await upload(e, b, "x")).status).toBe(201);
    // Another transaction holds the workspace's row lock (a long commit, a collection).
    const locker = new pg.Client({ connectionString: fx.database.adminUrl });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(
        "SELECT 1 FROM workspace_sync WHERE team_id = $1 AND user_id = $2 FOR UPDATE",
        [b.teamId, b.person.id],
      );
      const started = Date.now();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => commit(e, b, [put(`f${i}.txt`, "x")])),
      );
      const statuses = results.map((r) => r.status).sort();
      // One commit waited for the lock and gave up (503, retried later); the rest were refused
      // at once (429): they never took a connection.
      expect(statuses).toEqual([429, 429, 429, 429, 429, 503]);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await locker.query("ROLLBACK");
      await locker.end();
    }
    expect((await commit(e, b, [put("after.txt", "x")])).status).toBe(200);
  });

  it("caps database work across sandboxes per replica (others get 503, the API keeps its pool)", async () => {
    const e = env({}, { lockTimeoutMs: 1_000, dbInFlight: 1 });
    const a = await box();
    const other = await box();
    expect((await upload(e, a, "x")).status).toBe(201);
    const locker = new pg.Client({ connectionString: fx.database.adminUrl });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(
        "SELECT 1 FROM workspace_sync WHERE team_id = $1 AND user_id = $2 FOR UPDATE",
        [a.teamId, a.person.id],
      );
      const stuck = commit(e, a, [put("f.txt", "x")]);
      await new Promise((r) => setTimeout(r, 100));
      const res = await call(e, other, "GET", "/manifest");
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect((await stuck).status).toBe(503);
    } finally {
      await locker.query("ROLLBACK");
      await locker.end();
    }
    expect((await call(e, other, "GET", "/manifest")).status).toBe(200);
  });
});

/** Holds every put until `open()` (an upload still streaming into storage). */
class GatedObjects extends MemoryObjects {
  #open: () => void = () => {};
  readonly #gate = new Promise<void>((r) => (this.#open = r));
  started = 0;
  override async put(...args: Parameters<MemoryObjects["put"]>): Promise<void> {
    this.started += 1;
    await this.#gate;
    return super.put(...args);
  }
  open(): void {
    this.#open();
  }
}

describe("uploads: reservations and bounds", () => {
  it("an upload that ends while a commit holds the workspace lock waits briefly and is recorded", async () => {
    const objects = new GatedObjects();
    const e = env({}, { lockTimeoutMs: 300 }, {}, objects);
    const b = await box();
    const pending = upload(e, b, "late bytes");
    await expect.poll(() => objects.started).toBe(1); // reserved, streaming into storage
    const locker = new pg.Client({ connectionString: fx.database.adminUrl });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query(
      "SELECT 1 FROM workspace_sync WHERE team_id = $1 AND user_id = $2 FOR UPDATE",
      [b.teamId, b.person.id],
    );
    objects.open();
    // The finish times out on the lock (300 ms), backs off and retries; the lock goes meanwhile.
    await new Promise((r) => setTimeout(r, 700));
    await locker.query("ROLLBACK");
    await locker.end();
    expect((await pending).status).toBe(201);
    const c = await counters(b);
    expect(c).toMatchObject({ pending_blobs: 0, blob_count: 1 });
  });

  it("never lets concurrent uploads overshoot the byte budget (reserved before accepting bytes)", async () => {
    // Fresh uploads are within the grace period: a collection kicked by the pressure frees nothing.
    const e = env({ maxBlobBytes: 3 << 20 }, {}, { blobGraceMs: 60 * 60_000 });
    const b = await box();
    const blobs = Array.from({ length: 8 }, (_, i) => Buffer.alloc(1 << 20, i + 1));
    // Busy answers (429/503: in-flight caps) are retried, as the agent does.
    const definitive = async (d: Buffer): Promise<number> => {
      for (;;) {
        const res = await upload(e, b, d);
        if (res.status !== 429 && res.status !== 503) return res.status;
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const statuses = await Promise.all(blobs.map(definitive));
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 507)).toHaveLength(5);
    const c = await counters(b);
    expect(Number(c?.blob_bytes)).toBe(3 << 20);
    expect(c?.pending_blobs).toBe(0);
    expect(e.objects.keys(`teams/${b.teamId}/`)).toHaveLength(3);
  });

  it("caps the number of uncommitted blobs, and committing them frees room", async () => {
    const e = env({ maxUncommittedBlobs: 5 }, {}, { blobGraceMs: 60 * 60_000 });
    const b = await box();
    for (let i = 0; i < 5; i++) expect((await upload(e, b, `blob ${i}`)).status).toBe(201);
    expect((await upload(e, b, "blob 5")).status).toBe(507);
    const committed = await commit(e, b, [put("a.txt", "blob 0"), put("b.txt", "blob 1")]);
    expect(committed.body.results?.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect((await upload(e, b, "blob 5")).status).toBe(201);
    expect((await upload(e, b, "blob 6")).status).toBe(201);
    expect((await upload(e, b, "blob 7")).status).toBe(507);
  });

  it("collection drains a flood of uncommitted blobs in one run (batches within a time budget)", async () => {
    const e = env({ maxUncommittedBlobs: 100 }, {}, { batch: 7 });
    const b = await box();
    for (let i = 0; i < 40; i++) expect((await upload(e, b, `orphan ${i}`)).status).toBe(201);
    const result = await e.sync.collect();
    expect(result.blobs).toBeGreaterThanOrEqual(40);
    expect(e.objects.keys(`teams/${b.teamId}/`)).toEqual([]);
    const c = await counters(b);
    expect(c).toMatchObject({ blob_count: 0, pending_blobs: 0 });
    expect(Number(c?.blob_bytes)).toBe(0);
  });
});

describe("manifest rows (live + tombstones) are capped", () => {
  it("compacts tombstones at the cap instead of growing, and refuses only when all rows are live", async () => {
    const e = env({ maxFiles: 10, maxRows: 10 });
    const b = await box();
    expect((await upload(e, b, "x")).status).toBe(201);
    // Churn: create and delete 30 distinct paths.
    for (let i = 0; i < 30; i++) {
      const c = await commit(e, b, [put(`churn/${i}.txt`, "x")]);
      const rev = c.body.results?.[0]?.entry?.rev ?? 0;
      expect(
        (await commit(e, b, [{ op: "delete", path: `churn/${i}.txt`, base_rev: rev }])).status,
      ).toBe(200);
    }
    const c = await counters(b);
    expect(Number(c?.rows)).toBeLessThanOrEqual(10);
    expect(c?.tombstones).toBe(Number(c?.rows));
    // A puller from before the compaction must resync.
    expect((await call(e, b, "GET", "/manifest?since=1")).status).toBe(409);
    // All live: the cap holds.
    const fill = await commit(
      e,
      b,
      Array.from({ length: 11 }, (_, i) => put(`live/${i}.txt`, "x")),
    );
    expect(fill.body.results?.filter((r) => r.status === "applied")).toHaveLength(10);
    expect(fill.body.results?.at(-1)).toMatchObject({ status: "rejected", code: "too_many_files" });
    expect(Number((await counters(b))?.rows)).toBe(10);
  });
});

describe("collection grace runs from dereference", () => {
  it("keeps content that just stopped being referenced, even if it was uploaded long ago", async () => {
    const e = env({}, {}, { blobGraceMs: 60 * 60_000 });
    const b = await box();
    expect((await upload(e, b, "old content")).status).toBe(201);
    const first = await commit(e, b, [put("doc.txt", "old content")]);
    // Uploaded two hours ago.
    await fx.admin.query(
      `UPDATE workspace_blobs SET created_at = now() - interval '2 hours' WHERE team_id = $1`,
      [b.teamId],
    );
    expect((await upload(e, b, "new content")).status).toBe(201);
    const rev = first.body.results?.[0]?.entry?.rev ?? 0;
    expect((await commit(e, b, [put("doc.txt", "new content", rev)])).status).toBe(200);
    await e.sync.collect();
    // A reader that resolved the old entry just before the overwrite still finds it.
    expect(e.objects.objects.has(workspaceBlobKey("", b.owner, sha("old content")))).toBe(true);
    await fx.admin.query(
      `UPDATE workspace_blobs SET released_at = now() - interval '2 hours' WHERE team_id = $1`,
      [b.teamId],
    );
    await e.sync.collect();
    expect(e.objects.objects.has(workspaceBlobKey("", b.owner, sha("old content")))).toBe(false);
  });
});

describe("revocation", () => {
  it("a removed member's sandbox loses access at once, not after the cache expires", async () => {
    const e = env();
    const owner = await fx.person("rev-owner");
    const teamId = await fx.team(`wr-${randomBytes(3).toString("hex")}`, owner);
    const member = await fx.person("rev-member");
    await fx.addMember(teamId, member);
    const b = await box(member, teamId);
    expect((await call(e, b, "GET", "/manifest")).status).toBe(200); // cached as allowed
    await withTeam(fx.db, teamId, (tx) =>
      tx.execute(
        sql`DELETE FROM team_members WHERE team_id = ${teamId} AND user_id = ${member.id}`,
      ),
    );
    await fx.replica(0).deps.sandboxWire.revalidateUser(member.id);
    expect((await call(e, b, "GET", "/manifest")).status).toBe(401);
  });
});

describe("concurrency", () => {
  it("commits racing collection never leave a manifest row pointing at a deleted object", async () => {
    const e = env({}, { lockTimeoutMs: 5_000 });
    const b = await box();
    const contents = Array.from({ length: 6 }, (_, i) => `content ${i}`);
    let rev: number | null = null;
    for (let round = 0; round < 12; round++) {
      const data = contents[round % contents.length] ?? "x";
      // Re-upload (it may have been collected) and commit while a collection runs.
      const [up] = await Promise.all([upload(e, b, data), e.sync.collect()]);
      expect([200, 201, 409]).toContain(up.status);
      const change = put("hot.txt", data, rev);
      const [c] = await Promise.all([commit(e, b, [change]), e.sync.collect()]);
      const r = c.body.results?.[0];
      if (r?.status === "applied") rev = r.entry?.rev ?? rev;
    }
    const live = await fx.admin.query<{ blob_key: string }>(
      `SELECT blob_key FROM workspace_files WHERE team_id = $1 AND NOT deleted`,
      [b.teamId],
    );
    for (const row of live.rows)
      expect(e.objects.objects.has(row.blob_key), row.blob_key).toBe(true);
  });
});
