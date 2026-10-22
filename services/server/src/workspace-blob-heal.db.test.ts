import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKSPACE_SYNC_PATH, workspaceBlobsLostResponseSchema } from "@kobe/protocol";
import { createSandboxApp } from "./routes/sandbox.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandboxAuth } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { KEYS } from "./testing/sandbox-fixtures.js";
import {
  createSandboxAuthenticator,
  createWorkspaceSync,
  repairWorkspaces,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * KOBE-475: content the manifest says is stored but object storage lost (gate1's store move). A
 * read that finds the object missing, or the repair sweep, marks the blob lost; `GET blobs/lost`
 * lists it; a sandbox that still holds the bytes uploads them again (verified against the row's
 * hash and size, not counted against its limits twice) and the mark clears.
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
  readonly token: string;
}

async function box(): Promise<Box> {
  const person = await fx.person(`h${randomBytes(2).toString("hex")}`);
  const teamId = await fx.team(`heal-${randomBytes(3).toString("hex")}`, person);
  return {
    teamId,
    person,
    token: auth.issue({ sandboxId: randomUUID(), teamId, userId: person.id }),
  };
}

function call(b: Box, method: string, path: string, body?: unknown, raw?: Buffer) {
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
  return app.request(`${WORKSPACE_SYNC_PATH}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
}

/** Uploads and commits `content` at `path` the way the agent's push does. */
async function push(b: Box, path: string, content: string): Promise<string> {
  const data = Buffer.from(content);
  const hash = sha(data);
  expect((await call(b, "PUT", `/blobs/${hash}`, undefined, data)).status).toBe(201);
  const res = await call(b, "POST", "/commit", {
    changes: [
      {
        op: "put",
        path,
        base_rev: null,
        sha256: hash,
        size: data.length,
        mtime_ms: 1000,
        executable: false,
      },
    ],
  });
  expect(((await res.json()) as { results: { status: string }[] }).results[0]?.status).toBe(
    "applied",
  );
  return hash;
}

const keyOf = (b: Box, hash: string) =>
  workspaceBlobKey("", { teamId: b.teamId, userId: b.person.id }, hash);

async function lost(b: Box): Promise<string[]> {
  const res = await call(b, "GET", "/blobs/lost");
  expect(res.status).toBe(200);
  return workspaceBlobsLostResponseSchema.parse(await res.json()).lost;
}

async function counters(b: Box) {
  const { rows } = await fx.admin.query<{
    blob_count: number;
    blob_bytes: string;
    pending_blobs: number;
    pending_bytes: string;
    live_bytes: string;
  }>(
    `SELECT blob_count, blob_bytes, pending_blobs, pending_bytes, live_bytes FROM workspace_sync
      WHERE team_id = $1 AND user_id = $2`,
    [b.teamId, b.person.id],
  );
  return must(rows[0], "workspace_sync row");
}

async function lostAt(b: Box, hash: string) {
  const { rows } = await fx.admin.query<{ lost_at: Date | null }>(
    `SELECT lost_at FROM workspace_blobs WHERE team_id = $1 AND user_id = $2 AND sha256 = $3`,
    [b.teamId, b.person.id, hash],
  );
  return rows[0]?.lost_at ?? null;
}

describe("a blob missing from object storage (ac-1)", () => {
  it("is only listed once a read found the object missing (never from the row alone)", async () => {
    const b = await box();
    const hash = await push(b, "mortgage.py", "print('rate')\n");
    objects.objects.delete(keyOf(b, hash));
    expect(await lost(b)).toEqual([]);
    const read = await call(b, "GET", "/file?path=mortgage.py");
    expect(read.status).toBe(502);
    expect(((await read.json()) as { code: string }).code).toBe("content_missing");
    expect(await lost(b)).toEqual([hash]);
    // Asked about it, the server says it does not hold that content.
    const missing = await call(b, "POST", "/blobs/missing", { sha256: [hash] });
    expect(((await missing.json()) as { missing: string[] }).missing).toEqual([hash]);
  });

  it("is re-uploaded by the sandbox, verified, without counting it twice", async () => {
    const b = await box();
    const content = "a,b\n1,2\n";
    const hash = await push(b, "airbnb_sales.csv", content);
    objects.objects.delete(keyOf(b, hash));
    await call(b, "GET", "/file?path=airbnb_sales.csv");
    const before = await counters(b);
    // A full blob budget must not refuse content the workspace already counts.
    await fx.admin.query(
      `UPDATE workspace_sync SET blob_bytes = 999999999 WHERE team_id = $1 AND user_id = $2`,
      [b.teamId, b.person.id],
    );

    // Bytes that are not this content: refused, nothing stored, still lost.
    const wrong = Buffer.from("a,b\n9,9\n");
    expect((await call(b, "PUT", `/blobs/${hash}`, undefined, wrong)).status).toBe(422);
    expect(objects.objects.has(keyOf(b, hash))).toBe(false);
    expect(await lost(b)).toEqual([hash]);

    const res = await call(b, "PUT", `/blobs/${hash}`, undefined, Buffer.from(content));
    expect(res.status).toBe(201);
    expect(objects.objects.get(keyOf(b, hash))?.toString()).toBe(content);
    expect(await lost(b)).toEqual([]);
    expect(await lostAt(b, hash)).toBeNull();
    const after = await counters(b);
    expect(after).toEqual({ ...before, blob_bytes: "999999999" });

    const read = await call(b, "GET", "/file?path=airbnb_sales.csv");
    expect(read.status).toBe(200);
    expect(await read.text()).toBe(content);
  });

  it("a re-upload whose size differs from the row's is refused", async () => {
    const b = await box();
    const hash = await push(b, "x.txt", "twelve bytes");
    objects.objects.delete(keyOf(b, hash));
    await call(b, "GET", "/file?path=x.txt");
    // Same name, other length: the bytes can't be this content.
    const res = await call(b, "PUT", `/blobs/${hash}`, undefined, Buffer.from("short"));
    expect(res.status).toBe(422);
    expect(await lost(b)).toEqual([hash]);
  });

  it("collection still frees lost content no path references (and its mark goes too)", async () => {
    const b = await box();
    const hash = await push(b, "old.html", "<p>old</p>");
    objects.objects.delete(keyOf(b, hash));
    await call(b, "GET", "/file?path=old.html");
    const res = await call(b, "POST", "/commit", {
      changes: [{ op: "delete", path: "old.html", base_rev: 1 }],
    });
    expect(res.status).toBe(200);
    await sync.collect();
    expect(await lost(b)).toEqual([]);
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM workspace_blobs WHERE team_id = $1 AND sha256 = $2`,
      [b.teamId, hash],
    );
    expect(rows).toEqual([]);
  });

  it("is listed and accepted only while a live file references it", async () => {
    const b = await box();
    const hash = await push(b, "draft.md", "draft");
    objects.objects.delete(keyOf(b, hash));
    await call(b, "GET", "/file?path=draft.md");
    expect(await lost(b)).toEqual([hash]);
    await call(b, "POST", "/commit", {
      changes: [{ op: "delete", path: "draft.md", base_rev: 1 }],
    });
    expect(await lost(b)).toEqual([]);
    // Not a resend any more: like any held content, the upload stores nothing.
    expect((await call(b, "PUT", `/blobs/${hash}`, undefined, Buffer.from("draft"))).status).toBe(
      200,
    );
    expect(objects.objects.has(keyOf(b, hash))).toBe(false);
  });

  it("a resend racing collection leaves no orphaned object", async () => {
    const b = await box();
    const hash = await push(b, "race.txt", "racing bytes");
    const key = keyOf(b, hash);
    objects.objects.delete(key);
    await call(b, "GET", "/file?path=race.txt");
    const put = objects.put.bind(objects);
    objects.put = async (k, body, size) => {
      if (k === key) {
        // The file is deleted and its content collected while the bytes are on their way.
        await call(b, "POST", "/commit", {
          changes: [{ op: "delete", path: "race.txt", base_rev: 1 }],
        });
        await sync.collect();
      }
      return put(k, body, size);
    };
    try {
      const res = await call(b, "PUT", `/blobs/${hash}`, undefined, Buffer.from("racing bytes"));
      expect(res.status).toBe(409);
    } finally {
      objects.put = put;
    }
    expect(objects.objects.has(key)).toBe(false);
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM workspace_blobs WHERE team_id = $1 AND sha256 = $2`,
      [b.teamId, hash],
    );
    expect(rows).toEqual([]);
  });

  it("is invisible to other workspaces", async () => {
    const b = await box();
    const other = await box();
    const hash = await push(b, "mine.txt", "mine");
    objects.objects.delete(keyOf(b, hash));
    await call(b, "GET", "/file?path=mine.txt");
    expect(await lost(other)).toEqual([]);
    // Another workspace "healing" that hash only uploads into its own prefix.
    const res = await call(other, "PUT", `/blobs/${hash}`, undefined, Buffer.from("mine"));
    expect(res.status).toBe(201);
    expect(objects.objects.has(keyOf(b, hash))).toBe(false);
    expect(await lost(b)).toEqual([hash]);
  });
});

describe("repair sweep (ac-3)", () => {
  it("checks every live row against the store and marks what is missing; counts only", async () => {
    const b = await box();
    const ok = await push(b, "ok.txt", "still here");
    const gone1 = await push(b, "demo-dashboard.html", "<h1>dash</h1>");
    const gone2 = await push(b, "sales-chart.html", "<h1>chart</h1>");
    objects.objects.delete(keyOf(b, gone1));
    objects.objects.delete(keyOf(b, gone2));
    const owner = { teamId: b.teamId, userId: b.person.id };
    const lines: unknown[] = [];
    const log = { ...silent, info: (o: unknown) => lines.push(o) };

    const dry = await repairWorkspaces(fx.db, objects, { prefix: "", dryRun: true, ...owner }, log);
    expect(dry).toMatchObject({ workspaces: 1, checked: 3, missing: 2, marked: 0 });
    expect(await lost(b)).toEqual([]);

    const run = await repairWorkspaces(fx.db, objects, { prefix: "", ...owner }, log);
    expect(run).toMatchObject({ workspaces: 1, checked: 3, missing: 2, marked: 2 });
    expect((await lost(b)).sort()).toEqual([gone1, gone2].sort());
    expect(await lostAt(b, ok)).toBeNull();
    // Logs carry counts, never names or content.
    expect(JSON.stringify(lines)).not.toMatch(/dash|chart|\.html|\.txt/);

    // Again: already marked, nothing new.
    const again = await repairWorkspaces(fx.db, objects, { prefix: "", ...owner }, log);
    expect(again).toMatchObject({ missing: 2, marked: 0 });
  });

  it("covers every workspace of a team when only the team is given", async () => {
    const b = await box();
    const second = await fx.person(`h${randomBytes(2).toString("hex")}`);
    await fx.addMember(b.teamId, second);
    const c: Box = {
      teamId: b.teamId,
      person: second,
      token: auth.issue({ sandboxId: randomUUID(), teamId: b.teamId, userId: second.id }),
    };
    const hb = await push(b, "b.txt", `b-${randomUUID()}`);
    const hc = await push(c, "c.txt", `c-${randomUUID()}`);
    objects.objects.delete(keyOf(b, hb));
    objects.objects.delete(keyOf(c, hc));
    const first = await repairWorkspaces(
      fx.db,
      objects,
      { prefix: "", teamId: b.teamId, maxWorkspaces: 1, paceMs: 1 },
      silent,
    );
    expect(first).toMatchObject({ workspaces: 1, checked: 1, missing: 1, marked: 1 });
    const run = await repairWorkspaces(fx.db, objects, { prefix: "", teamId: b.teamId }, silent);
    expect(run).toMatchObject({ workspaces: 2, checked: 2, missing: 2, marked: 1 });
    expect(await lost(b)).toEqual([hb]);
    expect(await lost(c)).toEqual([hc]);
  });
});
