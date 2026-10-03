import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WORKSPACE_ENTRY_HEADER,
  WORKSPACE_SYNC_PATH,
  decodeWorkspaceEntryHeader,
  type WorkspaceChange,
  type WorkspaceEntry,
} from "@kobe/protocol";
import { sql, withTeam } from "@kobe/db";
import { createSandboxApp } from "./routes/sandbox.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandboxAuth } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { KEYS } from "./testing/sandbox-fixtures.js";
import {
  createSandboxAuthenticator,
  createWorkspaceSync,
  deleteServerFile,
  putServerFile,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * Workspace sync endpoints (KOBE-27) on the sandbox listener against a real Postgres: auth, the
 * push protocol (missing → upload → commit), integrity, compare-and-set conflicts, server-owned
 * areas, limits and quota, incremental pulls, collection, sharing, and cross-team isolation of
 * object keys.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
let sync: WorkspaceSync;
let app: ReturnType<typeof createSandboxApp>;

const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };

beforeAll(async () => {
  await fx.setup([{}]);
  sync = createWorkspaceSync({
    db: fx.db,
    objects,
    prefix: "",
    limits: LIMITS,
    collect: { blobGraceMs: 0, tombstoneTtlMs: 7 * 86_400_000 },
    log: silent,
  });
  app = createSandboxApp({
    provider: { identifyBootstrapToken: () => Promise.reject(new Error("unused")) },
    sessionKeys: KEYS,
    workspace: sync.routes(
      createSandboxAuthenticator({ db: fx.db, verify: auth.verify, liveness: auth.liveness }),
    ),
  });
});

afterAll(() => fx.teardown());

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

interface Box {
  readonly teamId: string;
  readonly person: Person;
  readonly sandboxId: string;
  readonly token: string;
}

async function box(person?: Person, teamId?: string): Promise<Box> {
  const p = person ?? (await fx.person(`w${randomBytes(2).toString("hex")}`));
  const t = teamId ?? (await fx.team(`ws-${randomBytes(3).toString("hex")}`, p));
  const sandboxId = randomUUID();
  return {
    teamId: t,
    person: p,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: t, userId: p.id }),
  };
}

function call(
  b: Box | string | undefined,
  method: string,
  path: string,
  body?: unknown,
  raw?: Buffer,
) {
  const headers: Record<string, string> = {};
  const token = typeof b === "string" ? b : b?.token;
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  let payload: string | Uint8Array<ArrayBuffer> | undefined;
  if (raw !== undefined) {
    payload = new Uint8Array(raw);
    headers["content-length"] = String(raw.length);
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return app.request(`${WORKSPACE_SYNC_PATH}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
}

async function upload(b: Box, content: string | Buffer): Promise<string> {
  const data = Buffer.from(content);
  const hash = sha(data);
  const res = await call(b, "PUT", `/blobs/${hash}`, undefined, data);
  expect([200, 201]).toContain(res.status);
  return hash;
}

async function commit(b: Box, changes: WorkspaceChange[]) {
  const res = await call(b, "POST", "/commit", { changes });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    head_rev: number;
    results: {
      status: string;
      path: string;
      entry?: WorkspaceEntry;
      current?: WorkspaceEntry;
      code?: string;
    }[];
  };
}

async function push(b: Box, path: string, content: string, baseRev: number | null = null) {
  const hash = await upload(b, content);
  const out = await commit(b, [
    {
      op: "put",
      path,
      base_rev: baseRev,
      sha256: hash,
      size: Buffer.byteLength(content),
      mtime_ms: 1000,
      executable: false,
    },
  ]);
  return must(out.results[0], "result");
}

async function manifest(b: Box, since = 0) {
  const res = await call(b, "GET", `/manifest?since=${since}`);
  return {
    status: res.status,
    body: (await res.json()) as { head_rev: number; entries: WorkspaceEntry[]; more: boolean },
  };
}

async function auditCount(teamId: string, action: string, field?: [string, string]) {
  const { rows } = await fx.admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE team_id = $1 AND action = $2 ${field ? `AND target->>'${field[0]}' = $3` : ""}`,
    field ? [teamId, action, field[1]] : [teamId, action],
  );
  return Number(rows[0]?.n ?? 0);
}

describe("authentication", () => {
  it("refuses missing, forged and dead sandbox tokens, and removed members", async () => {
    const b = await box();
    expect((await call(undefined, "GET", "/manifest")).status).toBe(401);
    expect((await call("forged", "GET", "/manifest")).status).toBe(401);
    expect((await call(b, "GET", "/manifest")).status).toBe(200);
    const dead = await box();
    auth.dead.add(dead.sandboxId);
    expect((await call(dead, "GET", "/manifest")).status).toBe(401);
    // A member removed from the team (fresh sandbox id: no cached positive answer).
    const other = await fx.person("leaver");
    await fx.addMember(b.teamId, other);
    const leaver = await box(other, b.teamId);
    expect((await call(leaver, "GET", "/manifest")).status).toBe(200);
    const fresh = await box(other, b.teamId);
    await withTeam(fx.db, b.teamId, (tx) =>
      tx.execute(
        sql`DELETE FROM team_members WHERE team_id = ${b.teamId} AND user_id = ${other.id}`,
      ),
    );
    expect((await call(fresh, "GET", "/manifest")).status).toBe(401);
  });

  it("is served only on the sandbox listener and refuses ingress-forwarded requests", async () => {
    const b = await box();
    const res = await app.request(`${WORKSPACE_SYNC_PATH}/manifest`, {
      headers: { authorization: `Bearer ${b.token}`, "x-forwarded-for": "1.2.3.4" },
    });
    expect(res.status).toBe(404);
  });
});

describe("push and pull", () => {
  it("uploads content once, commits paths and serves them back", async () => {
    const b = await box();
    const content = "quarterly numbers\n";
    const hash = sha(content);
    const missing = await call(b, "POST", "/blobs/missing", { sha256: [hash, hash] });
    expect(await missing.json()).toEqual({ missing: [hash] });
    expect(await upload(b, content)).toBe(hash);
    expect(await (await call(b, "POST", "/blobs/missing", { sha256: [hash] })).json()).toEqual({
      missing: [],
    });
    // Second upload of the same content: already held, nothing re-sent to storage.
    expect((await call(b, "PUT", `/blobs/${hash}`, undefined, Buffer.from(content))).status).toBe(
      200,
    );

    const r = await push(b, "reports/q3.md", content);
    expect(r).toMatchObject({
      status: "applied",
      entry: { path: "reports/q3.md", rev: 1, sha256: hash, origin: "sandbox" },
    });
    // The object lives under the workspace's own prefix, named by its hash.
    const key = workspaceBlobKey("", { teamId: b.teamId, userId: b.person.id }, hash);
    expect(key).toBe(`teams/${b.teamId}/users/${b.person.id}/workspace/${hash}`);
    expect(objects.objects.get(key)?.toString()).toBe(content);

    const file = await call(b, "GET", `/file?path=${encodeURIComponent("reports/q3.md")}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(content);
    expect(decodeWorkspaceEntryHeader(file.headers.get(WORKSPACE_ENTRY_HEADER))).toMatchObject({
      rev: 1,
      sha256: hash,
    });
    expect((await call(b, "GET", "/file?path=nope.txt")).status).toBe(404);
    expect((await call(b, "GET", "/file?path=../etc/passwd")).status).toBe(400);

    const m = await manifest(b);
    expect(m.body).toMatchObject({ head_rev: 1, more: false });
    expect(m.body.entries.map((e) => e.path)).toEqual(["reports/q3.md"]);
    expect(JSON.stringify(m.body)).not.toContain("teams/"); // never an object key
  });

  it("refuses bytes that do not hash to their name, stores nothing and audits it", async () => {
    const b = await box();
    const claimed = sha("the real content");
    const res = await call(
      b,
      "PUT",
      `/blobs/${claimed}`,
      undefined,
      Buffer.from("something else!!"),
    );
    expect(res.status).toBe(422);
    expect(objects.keys(`teams/${b.teamId}/`)).toEqual([]);
    const c = await commit(b, [
      {
        op: "put",
        path: "a.txt",
        base_rev: null,
        sha256: claimed,
        size: 16,
        mtime_ms: 1,
        executable: false,
      },
    ]);
    expect(c.results[0]).toMatchObject({ status: "rejected", code: "missing_blob" });
    await expect.poll(() => auditCount(b.teamId, "workspace.integrity_failed")).toBe(1);
    // A second mismatch within the minute is counted into the next row, not dropped.
    await call(b, "PUT", `/blobs/${claimed}`, undefined, Buffer.from("something else!!"));
    expect(await auditCount(b.teamId, "workspace.integrity_failed")).toBe(1);
  });

  it("pages incremental pulls and keeps tombstones", async () => {
    const b = await box();
    const a = await push(b, "a.txt", "A");
    await push(b, "b.txt", "B");
    const del = await commit(b, [
      { op: "delete", path: "a.txt", base_rev: must(a.entry, "a").rev },
    ]);
    expect(del.results[0]).toMatchObject({ status: "applied", entry: { deleted: true, rev: 3 } });
    expect(del.results[0]?.entry?.sha256).toBeUndefined();
    const since1 = await manifest(b, 1);
    expect(since1.body.entries.map((e) => [e.path, e.rev, e.deleted])).toEqual([
      ["b.txt", 2, false],
      ["a.txt", 3, true],
    ]);
    const paged = await call(b, "GET", "/manifest?since=0&limit=1");
    expect(await paged.json()).toMatchObject({
      head_rev: 3,
      more: true,
      entries: [{ path: "b.txt" }],
    });
    const noop = await commit(b, [{ op: "delete", path: "a.txt", base_rev: 3 }]);
    expect(noop.results[0]).toMatchObject({ status: "noop" });
  });
});

describe("consistency", () => {
  it("applies a change only on the revision it was based on (compare-and-set)", async () => {
    const b = await box();
    const owner = { teamId: b.teamId, userId: b.person.id };
    const first = await push(b, "notes.md", "v1");
    const rev1 = must(first.entry, "entry").rev;
    // The server writes the same path meanwhile (e.g. a file-browser upload, KOBE-54).
    const serverHash = await upload(b, "from the browser");
    await withTeam(fx.db, b.teamId, (tx) =>
      sync.putServerFile(tx, owner, {
        path: "notes.md",
        sha256: serverHash,
        size: 16,
        blobKey: workspaceBlobKey("", owner, serverHash),
      }),
    );
    const stale = await push(b, "notes.md", "v2 from the sandbox", rev1);
    expect(stale).toMatchObject({
      status: "conflict",
      current: { rev: 2, origin: "server", sha256: serverHash },
    });
    // Based on the current revision it applies.
    expect(await push(b, "notes.md", "v2 from the sandbox", 2)).toMatchObject({
      status: "applied",
    });
    // A delete based on an old revision is a conflict too (a deletion never beats a modification).
    expect(
      (await commit(b, [{ op: "delete", path: "notes.md", base_rev: rev1 }])).results[0],
    ).toMatchObject({
      status: "conflict",
    });
    // A modification of a path deleted meanwhile is applied on top of the tombstone.
    await withTeam(fx.db, b.teamId, (tx) => deleteServerFile(tx, owner, "notes.md"));
    expect(await push(b, "notes.md", "still mine", 3)).toMatchObject({ status: "applied" });
  });

  it("never accepts sandbox writes to server-owned or agent-internal areas", async () => {
    const b = await box();
    const hash = await upload(b, "x");
    const out = await commit(
      b,
      ["uploads/t1/sales.csv", "projects/acme/spec.md", ".kobe/sessions/t.jsonl"].map((path) => ({
        op: "put" as const,
        path,
        base_rev: null,
        sha256: hash,
        size: 1,
        mtime_ms: 1,
        executable: false,
      })),
    );
    expect(out.results.map((r) => r.status + ":" + (r.code ?? ""))).toEqual([
      "rejected:read_only",
      "rejected:read_only",
      "rejected:read_only",
    ]);
    expect(
      (
        await call(b, "POST", "/commit", {
          changes: [
            {
              op: "put",
              path: "../x",
              base_rev: null,
              sha256: hash,
              size: 1,
              mtime_ms: 1,
              executable: false,
            },
          ],
        })
      ).status,
    ).toBe(400);
  });

  it("delivers server writes (uploads, project files) to the sandbox's next pull", async () => {
    const b = await box();
    const owner = { teamId: b.teamId, userId: b.person.id };
    const before = await manifest(b);
    const uploadKey = `teams/${b.teamId}/uploads/obj-1`;
    objects.objects.set(uploadKey, Buffer.from("a,b\n1,2\n"));
    await withTeam(fx.db, b.teamId, (tx) =>
      sync.putServerFile(tx, owner, {
        path: "uploads/thread-1/sales.csv",
        sha256: sha("a,b\n1,2\n"),
        size: 8,
        blobKey: uploadKey,
      }),
    );
    // A server write can only point at this team's tree, and in users/ at this user's.
    for (const blobKey of [
      `teams/${randomUUID()}/uploads/obj-1`,
      `teams/${b.teamId}/users/${randomUUID()}/workspace/${"a".repeat(64)}`,
      `teams/${b.teamId}/../x`,
      "elsewhere/obj",
    ]) {
      await expect(
        withTeam(fx.db, b.teamId, (tx) =>
          putServerFile(
            tx,
            owner,
            { path: "uploads/x.csv", sha256: "a".repeat(64), size: 1, blobKey },
            { prefix: "" },
          ),
        ),
      ).rejects.toThrow(/blobKey/);
    }
    const after = await manifest(b, before.body.head_rev);
    expect(after.body.entries).toEqual([
      expect.objectContaining({ path: "uploads/thread-1/sales.csv", origin: "server", size: 8 }),
    ]);
    const file = await call(
      b,
      "GET",
      `/file?path=${encodeURIComponent("uploads/thread-1/sales.csv")}`,
    );
    expect(await file.text()).toBe("a,b\n1,2\n");
  });
});

describe("limits and quota (KOBE-53 seam)", () => {
  it("refuses oversized files, too many files and too many bytes, and audits it", async () => {
    const b = await box();
    const big = Buffer.alloc(LIMITS.maxFileBytes + 1, 1);
    expect((await call(b, "PUT", `/blobs/${sha(big)}`, undefined, big)).status).toBe(413);
    expect((await call(b, "PUT", `/blobs/${sha("x")}`, undefined, undefined)).status).toBe(411);
    const hash = await upload(b, "y");
    const changes = Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => ({
      op: "put" as const,
      path: `many/${i}.txt`,
      base_rev: null,
      sha256: hash,
      size: 1,
      mtime_ms: 1,
      executable: false,
    }));
    const out = await commit(b, changes);
    expect(out.results.filter((r) => r.status === "applied")).toHaveLength(LIMITS.maxFiles);
    expect(out.results.at(-1)).toMatchObject({ status: "rejected", code: "too_many_files" });
    await expect
      .poll(() => auditCount(b.teamId, "sandbox.limit_exceeded", ["limit", "workspace_files"]))
      .toBe(1);

    const c = await box();
    const mib = Buffer.alloc(LIMITS.maxFileBytes, 7);
    const mibHash = await upload(c, mib);
    const bytes = await commit(
      c,
      Array.from({ length: 5 }, (_, i) => ({
        op: "put" as const,
        path: `big/${i}.bin`,
        base_rev: null,
        sha256: mibHash,
        size: mib.length,
        mtime_ms: 1,
        executable: false,
      })),
    );
    expect(bytes.results.map((r) => r.code ?? r.status)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
      "quota_exceeded",
    ]);
    await expect
      .poll(() => auditCount(c.teamId, "sandbox.limit_exceeded", ["limit", "workspace_bytes"]))
      .toBe(1);
    await expect
      .poll(() => auditCount(b.teamId, "sandbox.limit_exceeded", ["limit", "workspace_file_size"]))
      .toBe(1);
  });
});

describe("isolation of object keys", () => {
  it("never serves or reuses another team's or another user's content", async () => {
    const a = await box();
    await push(a, "secret.txt", "team A's secret");
    // The same person in another team, and another person in the same team.
    const sameUserOtherTeam = await box(a.person);
    const otherUser = await fx.person("colleague");
    await fx.addMember(a.teamId, otherUser);
    const sameTeamOtherUser = await box(otherUser, a.teamId);
    for (const intruder of [sameUserOtherTeam, sameTeamOtherUser]) {
      expect((await call(intruder, "GET", "/file?path=secret.txt")).status).toBe(404);
      expect((await manifest(intruder)).body.entries).toEqual([]);
      // Knowing the hash is not enough: the content is not held for this workspace.
      const hash = sha("team A's secret");
      expect(
        await (await call(intruder, "POST", "/blobs/missing", { sha256: [hash] })).json(),
      ).toEqual({
        missing: [hash],
      });
      const c = await commit(intruder, [
        {
          op: "put",
          path: "stolen.txt",
          base_rev: null,
          sha256: hash,
          size: 15,
          mtime_ms: 1,
          executable: false,
        },
      ]);
      expect(c.results[0]).toMatchObject({ status: "rejected", code: "missing_blob" });
    }
    // RLS: team B's transaction cannot see team A's manifest rows at all.
    const rows = await withTeam(fx.db, sameUserOtherTeam.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM workspace_files WHERE team_id = ${a.teamId}`),
    );
    expect(rows.rows[0]).toEqual({ n: 0 });
  });
});

describe("collection, sharing and restore reports", () => {
  it("collects unreferenced blobs, keeps referenced ones, and audits counts", async () => {
    const b = await box();
    const owner = { teamId: b.teamId, userId: b.person.id };
    const v1 = await push(b, "doc.txt", "version 1");
    await push(b, "doc.txt", "version 2", must(v1.entry, "v1").rev);
    const orphan = await upload(b, "uploaded, never committed");
    await sync.collect();
    const keys = objects.keys(`teams/${b.teamId}/`);
    expect(keys).toEqual([workspaceBlobKey("", owner, sha("version 2"))]);
    expect(objects.deleted).toContain(workspaceBlobKey("", owner, orphan));
    expect(await auditCount(b.teamId, "workspace.purged")).toBe(1);
    // Collected content is "missing" again, so a later push uploads it anew.
    expect(await (await call(b, "POST", "/blobs/missing", { sha256: [orphan] })).json()).toEqual({
      missing: [orphan],
    });
  });

  it("shares a file to a durable object that outlives the workspace copy", async () => {
    const b = await box();
    const owner = { teamId: b.teamId, userId: b.person.id };
    const put = await push(b, "out/chart.html", "<svg/>");
    const shared = await withTeam(fx.db, b.teamId, (tx) =>
      sync.shareFile(tx, owner, "out/chart.html"),
    );
    expect(shared).toMatchObject({ sha256: sha("<svg/>"), size: 6 });
    expect(shared?.blobKey).toBe(
      `teams/${b.teamId}/users/${b.person.id}/shared/${shared?.sharedId}`,
    );
    // The volume is lost and the workspace file deleted and collected: the share stays.
    await commit(b, [{ op: "delete", path: "out/chart.html", base_rev: must(put.entry, "e").rev }]);
    await sync.collect();
    expect(objects.objects.has(workspaceBlobKey("", owner, sha("<svg/>")))).toBe(false);
    expect(objects.objects.get(must(shared, "shared").blobKey)?.toString()).toBe("<svg/>");
    expect(await auditCount(b.teamId, "workspace.file_shared")).toBe(1);
    expect(
      await withTeam(fx.db, b.teamId, (tx) => sync.shareFile(tx, owner, "nope")),
    ).toBeUndefined();
  });

  it("purges old tombstones and asks stale pullers to resync", async () => {
    const b = await box();
    const owner = { teamId: b.teamId, userId: b.person.id };
    const a = await push(b, "gone.txt", "bye");
    await push(b, "kept.txt", "hi");
    await commit(b, [{ op: "delete", path: "gone.txt", base_rev: must(a.entry, "a").rev }]);
    const aggressive = createWorkspaceSync({
      db: fx.db,
      objects,
      prefix: "",
      limits: LIMITS,
      collect: { blobGraceMs: 0, tombstoneTtlMs: 0 },
      log: silent,
    });
    await aggressive.collect();
    expect((await manifest(b, 1)).status).toBe(409);
    const full = await manifest(b, 0);
    expect(full.body.entries.map((e) => e.path)).toEqual(["kept.txt"]);
    expect(owner.userId).toBe(b.person.id);
  });

  it("records restores; a full restore onto an empty volume is audited", async () => {
    const b = await box();
    const report = { mode: "full", files: 12, bytes: 3456, duration_ms: 789 };
    expect((await call(b, "POST", "/restore-report", report)).status).toBe(204);
    expect(
      (await call(b, "POST", "/restore-report", { ...report, mode: "incremental" })).status,
    ).toBe(204);
    expect((await call(b, "POST", "/restore-report", { mode: "full" })).status).toBe(400);
    const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'workspace.restored'`,
      [b.teamId],
    );
    expect(rows.map((r) => r.target)).toEqual([
      { sandboxId: b.sandboxId, userId: b.person.id, files: 12, bytes: 3456, durationMs: 789 },
    ]);
    const state = await fx.admin.query<{ last_restore_ms: number }>(
      `SELECT last_restore_ms FROM workspace_sync WHERE team_id = $1`,
      [b.teamId],
    );
    expect(state.rows[0]?.last_restore_ms).toBe(789);
  });
});
