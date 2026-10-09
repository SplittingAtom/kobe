import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  workspaceFileEntrySchema,
  workspaceFileErrorSchema,
  workspaceListResponseSchema,
  type WorkspaceChange,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { createApp } from "./app.js";
import {
  EventStreamFixture,
  PUBLIC_URL,
  must,
  type Person,
} from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RawBody, TestBrowser } from "./testing/browser.js";
import { commitChanges } from "./workspace-sync/store.js";
import {
  createWorkspaceSync,
  limitsQuota,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * Workspace file browser API (KOBE-148) against a real Postgres: listing from the synced
 * manifest, downloads, uploads, deletes, the wake, and that everything stays inside the caller's
 * own (team, user) workspace.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };
const woken: { teamId: string; userId: string }[] = [];
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await fx.setup([{}]);
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: {
      sync,
      waker: {
        wake: (target) => {
          woken.push(target);
          return Promise.resolve();
        },
      },
    },
  });
});

afterAll(() => fx.teardown());

interface World {
  readonly team: string;
  readonly alice: Person;
  readonly bob: Person;
  readonly a: TestBrowser;
  readonly b: TestBrowser;
}

/** A browser on the app with the workspace routes, signed in as `p` (same session cookie). */
function browserFor(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

async function world(): Promise<World> {
  const alice = await fx.person("alice");
  const bob = await fx.person("bob");
  const team = await fx.team(`w-${randomBytes(3).toString("hex")}`, alice, [bob]);
  return { team, alice, bob, a: browserFor(alice, team), b: browserFor(bob, team) };
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Seeds a synced file the way a sandbox push or a server write would leave it. */
async function seed(
  w: World,
  who: Person,
  path: string,
  content: string,
  area: "user" | "uploads" | "projects" = "user",
): Promise<void> {
  const data = Buffer.from(content);
  const owner = { teamId: w.team, userId: who.id };
  const hash = sha(data);
  const key =
    area === "user" ? workspaceBlobKey("", owner, hash) : `teams/${w.team}/${area}/${randomUUID()}`;
  objects.objects.set(key, data);
  await withTeam(fx.db, w.team, (tx) =>
    sync.putServerFile(tx, owner, { path, sha256: hash, size: data.length, blobKey: key }, area),
  );
}

function multipart(fields: Record<string, string>, file?: { name: string; data: string }) {
  const boundary = `----kobe${randomBytes(6).toString("hex")}`;
  let body = "";
  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  if (file) {
    body +=
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${file.data}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  const bytes = Buffer.from(body);
  return {
    raw: new RawBody(bytes, `multipart/form-data; boundary=${boundary}`),
    headers: { "content-length": String(bytes.length) },
  };
}

function upload(b: TestBrowser, folder: string | undefined, name: string, data: string) {
  const m = multipart(folder === undefined ? {} : { path: folder }, { name, data });
  return b.request("POST", "/v1/workspace/files", m.raw, m.headers);
}

async function auditRows(team: string, action: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

describe("GET /v1/workspace/files", () => {
  it("lists a folder from the synced manifest: dirs first, areas and owners", async () => {
    const w = await world();
    await seed(w, w.alice, "notes.md", "# hi");
    await seed(w, w.alice, "src/a.ts", "a");
    await seed(w, w.alice, "src/deep/b.ts", "bb");
    await seed(w, w.alice, "uploads/t1/report.pdf", "pdf", "uploads");
    const root = await w.a.get("/v1/workspace/files");
    expect(root.status).toBe(200);
    const body = workspaceListResponseSchema.parse(root.json);
    expect(body.path).toBe("");
    expect(body.entries.map((e) => [e.name, e.type, e.area, e.owner, e.source])).toEqual([
      ["src", "dir", "workspace", "sandbox", "synced"],
      ["uploads", "dir", "uploads", "server", "synced"],
      ["notes.md", "file", "workspace", "sandbox", "synced"],
    ]);
    const notes = must(
      body.entries.find((e) => e.name === "notes.md"),
      "notes",
    );
    expect(notes).toMatchObject({
      path: "notes.md",
      size_bytes: 4,
      sha256: sha(Buffer.from("# hi")),
    });
    const src = workspaceListResponseSchema.parse(
      (await w.a.get("/v1/workspace/files?path=src")).json,
    );
    expect(src.entries.map((e) => [e.path, e.type, e.size_bytes])).toEqual([
      ["src/deep", "dir", null],
      ["src/a.ts", "file", 1],
    ]);
    const up = workspaceListResponseSchema.parse(
      (await w.a.get("/v1/workspace/files?path=uploads/t1")).json,
    );
    expect(up.entries).toMatchObject([
      { path: "uploads/t1/report.pdf", owner: "server", area: "uploads" },
    ]);
  });

  it("an empty root is an empty list; an unknown folder is not_found; bad paths are refused", async () => {
    const w = await world();
    expect((await w.a.get("/v1/workspace/files")).json).toEqual({ path: "", entries: [] });
    const missing = await w.a.get("/v1/workspace/files?path=nope");
    expect(missing.status).toBe(404);
    expect(workspaceFileErrorSchema.parse(missing.json).code).toBe("not_found");
    for (const bad of ["../x", "a/../b", "/abs", "a//b"]) {
      const res = await w.a.get(`/v1/workspace/files?path=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("invalid_path");
    }
    expect((await w.a.get("/v1/workspace/files?path=a&x=1")).status).toBe(400);
  });

  it("never lists deleted files, and works with no sandbox at all (no wake)", async () => {
    const w = await world();
    const before = woken.length;
    await seed(w, w.alice, "gone.txt", "x");
    await seed(w, w.alice, "kept.txt", "y");
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=gone.txt")).status).toBe(204);
    const list = workspaceListResponseSchema.parse((await w.a.get("/v1/workspace/files")).json);
    expect(list.entries.map((e) => e.name)).toEqual(["kept.txt"]);
    expect(woken.length).toBe(before);
  });

  it("shows only the caller's own workspace, never a teammate's", async () => {
    const w = await world();
    await seed(w, w.alice, "secret.txt", "alice only");
    await seed(w, w.bob, "bobs.txt", "bob only");
    expect(
      workspaceListResponseSchema
        .parse((await w.b.get("/v1/workspace/files")).json)
        .entries.map((e) => e.name),
    ).toEqual(["bobs.txt"]);
    expect(
      workspaceListResponseSchema
        .parse((await w.a.get("/v1/workspace/files")).json)
        .entries.map((e) => e.name),
    ).toEqual(["secret.txt"]);
  });

  it("requires a session", async () => {
    const anon = new TestBrowser(app, PUBLIC_URL);
    expect((await anon.get("/v1/workspace/files")).status).toBe(401);
    expect((await anon.get("/v1/workspace/file?path=a")).status).toBe(401);
  });
});

describe("GET /v1/workspace/file (download)", () => {
  it("streams the current version as an attachment, nosniff, with an audit row", async () => {
    const w = await world();
    await seed(w, w.alice, 'dir/résumé "v1".txt', "hello bytes");
    const res = await w.a.get(
      `/v1/workspace/file?path=${encodeURIComponent('dir/résumé "v1".txt')}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe("hello bytes");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe("11");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(
      /^attachment; filename="r_sum_ _v1_\.txt"; filename\*=UTF-8''r%C3%A9sum%C3%A9%20%22v1%22\.txt$/,
    );
    expect(await auditRows(w.team, "workspace.file_downloaded")).toEqual([
      { userId: w.alice.id, bytes: 11 },
    ]);
  });

  it("serves the newest content after an edit", async () => {
    const w = await world();
    await seed(w, w.alice, "f.txt", "one");
    await seed(w, w.alice, "f.txt", "two!");
    expect((await w.a.get("/v1/workspace/file?path=f.txt")).text).toBe("two!");
  });

  it("resolves against the manifest only: traversal, folders, deleted and unknown paths", async () => {
    const w = await world();
    await seed(w, w.alice, "d/x.txt", "x");
    for (const bad of ["../etc/passwd", "d/../d/x.txt", "/d/x.txt", ""]) {
      const res = await w.a.get(`/v1/workspace/file?path=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
    }
    expect((await w.a.get("/v1/workspace/file")).status).toBe(400);
    for (const missing of ["d", "d/y.txt", "nope"]) {
      const res = await w.a.get(`/v1/workspace/file?path=${missing}`);
      expect(res.status, missing).toBe(404);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("not_found");
    }
    await w.a.request("DELETE", "/v1/workspace/files?path=d/x.txt");
    expect((await w.a.get("/v1/workspace/file?path=d/x.txt")).status).toBe(404);
  });

  it("cannot read a teammate's file, even by exact path", async () => {
    const w = await world();
    await seed(w, w.alice, "secret.txt", "alice only");
    const res = await w.b.get("/v1/workspace/file?path=secret.txt");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("alice only");
    expect(await auditRows(w.team, "workspace.file_downloaded")).toEqual([]);
  });

  it("a missing object is a 404, not a crash", async () => {
    const w = await world();
    await seed(w, w.alice, "lost.txt", "poof");
    objects.lost.add(
      workspaceBlobKey("", { teamId: w.team, userId: w.alice.id }, sha(Buffer.from("poof"))),
    );
    expect((await w.a.get("/v1/workspace/file?path=lost.txt")).status).toBe(404);
  });
});

describe("POST /v1/workspace/files (upload)", () => {
  it("stores the file under the folder, as a server write the sandbox will pull", async () => {
    const w = await world();
    const res = await upload(w.a, "docs/in", "plan.txt", "the plan");
    expect(res.status, res.text).toBe(201);
    const entry = workspaceFileEntrySchema.parse(res.json);
    expect(entry).toMatchObject({
      name: "plan.txt",
      path: "docs/in/plan.txt",
      type: "file",
      size_bytes: 8,
      source: "synced",
      area: "workspace",
      sha256: sha(Buffer.from("the plan")),
    });
    const { rows } = await fx.admin.query<{ origin: string; rev: string; blob_key: string }>(
      `SELECT origin, rev, blob_key FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = $3`,
      [w.team, w.alice.id, "docs/in/plan.txt"],
    );
    expect(rows[0]).toMatchObject({ origin: "server" });
    expect(objects.objects.get(must(rows[0], "row").blob_key)?.toString()).toBe("the plan");
    expect((await w.a.get("/v1/workspace/file?path=docs/in/plan.txt")).text).toBe("the plan");
    expect(await auditRows(w.team, "workspace.file_uploaded")).toEqual([
      { userId: w.alice.id, bytes: 8 },
    ]);
  });

  it("uploads to the root when no folder is given", async () => {
    const w = await world();
    const res = await upload(w.a, undefined, "top.txt", "t");
    expect(res.status).toBe(201);
    expect(workspaceFileEntrySchema.parse(res.json).path).toBe("top.txt");
  });

  it("does not overwrite: an existing file, a folder or a file in the way is already_exists", async () => {
    const w = await world();
    await seed(w, w.alice, "a/b.txt", "b");
    await seed(w, w.alice, "flat", "f");
    for (const [folder, name] of [
      ["a", "b.txt"], // same file
      ["", "a"], // a folder with that name
      ["flat", "x.txt"], // a file where the folder would go
    ] as const) {
      const res = await upload(w.a, folder, name, "new");
      expect(res.status, `${folder}/${name}`).toBe(409);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("already_exists");
    }
    expect((await w.a.get("/v1/workspace/file?path=a/b.txt")).text).toBe("b");
  });

  it("refuses the server-owned areas and the agent-internal one", async () => {
    const w = await world();
    for (const folder of ["uploads", "uploads/t1", "projects/p", ".kobe", ".kobe/s"]) {
      const res = await upload(w.a, folder, "x.txt", "x");
      expect(res.status, folder).toBe(folder.startsWith(".kobe") ? 400 : 403);
    }
    expect(workspaceFileErrorSchema.parse((await upload(w.a, "uploads", "x", "x")).json).code).toBe(
      "read_only",
    );
  });

  it("validates the request: file name, folder, fields, parts, length", async () => {
    const w = await world();
    expect((await upload(w.a, "../up", "x.txt", "x")).status).toBe(400);
    const none = multipart({ path: "a" });
    expect((await w.a.request("POST", "/v1/workspace/files", none.raw, none.headers)).status).toBe(
      400,
    );
    const extra = multipart({ path: "a", other: "1" }, { name: "x", data: "x" });
    expect(
      (await w.a.request("POST", "/v1/workspace/files", extra.raw, extra.headers)).status,
    ).toBe(400);
    const m = multipart({}, { name: "x", data: "x" });
    expect((await w.a.request("POST", "/v1/workspace/files", m.raw)).status).toBe(411);
    const json = await w.a.request("POST", "/v1/workspace/files", { path: "a" });
    expect(json.status).toBe(415);
  });

  it("enforces the file size limit and the workspace quota", async () => {
    const w = await world();
    const big = await upload(w.a, "", "big.bin", "x".repeat(LIMITS.maxFileBytes + 1));
    expect(big.status).toBe(413);
    expect(workspaceFileErrorSchema.parse(big.json).code).toBe("file_too_large");
    const tiny = createApp(fx.replica(0).deps, {
      workspaceFiles: {
        sync: Object.assign(Object.create(sync) as WorkspaceSync, {
          quota: limitsQuota({ ...LIMITS, maxFiles: 1 }),
        }),
        waker: { wake: () => Promise.resolve() },
      },
    });
    const b = new TestBrowser(tiny, PUBLIC_URL);
    for (const [k, v] of w.alice.browser.cookies) b.cookies.set(k, v);
    b.team = w.team;
    expect((await upload(b, "", "one.txt", "1")).status).toBe(201);
    const second = await upload(b, "", "two.txt", "2");
    expect(second.status).toBe(507);
    expect(workspaceFileErrorSchema.parse(second.json).code).toBe("quota_exceeded");
  });

  it("keeps a concurrent sandbox edit as a conflict (the sandbox's stale write is not applied)", async () => {
    const w = await world();
    const owner = { teamId: w.team, userId: w.alice.id };
    const hash = sha(Buffer.from("sandbox edit"));
    const stale: WorkspaceChange = {
      op: "put",
      path: "doc.txt",
      base_rev: null,
      sha256: hash,
      size: 12,
      mtime_ms: Date.now(),
      executable: false,
    };
    expect((await upload(w.a, "", "doc.txt", "from browser")).status).toBe(201);
    const outcome = await withTeam(fx.db, w.team, (tx) =>
      commitChanges(tx, owner, [stale], {
        prefix: "",
        quota: sync.quota,
        maxRows: 100,
      }),
    );
    expect(outcome.results[0]).toMatchObject({ status: "conflict", path: "doc.txt" });
    expect((await w.a.get("/v1/workspace/file?path=doc.txt")).text).toBe("from browser");
  });

  it("reuses content a workspace already holds (no second object)", async () => {
    const w = await world();
    await seed(w, w.alice, "orig.txt", "same bytes");
    const before = objects.objects.size;
    expect((await upload(w.a, "", "copy.txt", "same bytes")).status).toBe(201);
    expect(objects.objects.size).toBe(before);
  });
});

describe("DELETE /v1/workspace/files", () => {
  it("tombstones a file in the manifest (rev bumped, sandbox pulls it) and audits counts only", async () => {
    const w = await world();
    await seed(w, w.alice, "x/del.txt", "12345");
    const res = await w.a.request("DELETE", "/v1/workspace/files?path=x/del.txt");
    expect(res.status).toBe(204);
    const { rows } = await fx.admin.query<{ deleted: boolean; origin: string; size: string }>(
      `SELECT deleted, origin, size FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = 'x/del.txt'`,
      [w.team, w.alice.id],
    );
    expect(rows[0]).toMatchObject({ deleted: true, origin: "server", size: "5" });
    expect(await auditRows(w.team, "workspace.file_deleted")).toEqual([
      { userId: w.alice.id, files: 1, bytes: 5 },
    ]);
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=x/del.txt")).status).toBe(404);
  });

  it("deletes a folder's files together", async () => {
    const w = await world();
    await seed(w, w.alice, "tree/a", "1");
    await seed(w, w.alice, "tree/sub/b", "22");
    await seed(w, w.alice, "treehouse", "keep");
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=tree")).status).toBe(204);
    const list = workspaceListResponseSchema.parse((await w.a.get("/v1/workspace/files")).json);
    expect(list.entries.map((e) => e.name)).toEqual(["treehouse"]);
    expect(await auditRows(w.team, "workspace.file_deleted")).toEqual([
      { userId: w.alice.id, files: 2, bytes: 3 },
    ]);
  });

  it("refuses project mounts and uploads (read only), and the root", async () => {
    const w = await world();
    await seed(w, w.alice, "projects/p/readme.md", "r", "projects");
    await seed(w, w.alice, "uploads/t/f.txt", "u", "uploads");
    for (const path of [
      "projects/p/readme.md",
      "projects/p",
      "projects",
      "uploads/t/f.txt",
      "uploads",
    ]) {
      const res = await w.a.request("DELETE", `/v1/workspace/files?path=${path}`);
      expect(res.status, path).toBe(403);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("read_only");
    }
    expect((await w.a.get("/v1/workspace/file?path=projects/p/readme.md")).status).toBe(200);
    expect((await w.a.request("DELETE", "/v1/workspace/files")).status).toBe(400);
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=")).status).toBe(400);
    expect(await auditRows(w.team, "workspace.file_deleted")).toEqual([]);
  });

  it("cannot delete a teammate's file", async () => {
    const w = await world();
    await seed(w, w.alice, "secret.txt", "alice only");
    expect((await w.b.request("DELETE", "/v1/workspace/files?path=secret.txt")).status).toBe(404);
    expect((await w.a.get("/v1/workspace/file?path=secret.txt")).text).toBe("alice only");
  });

  it("is refused while a legal hold covers the user", async () => {
    const w = await world();
    await seed(w, w.alice, "evidence.txt", "keep me");
    // The two-person flow has its own tests (KOBE-17); the guard trigger is bypassed to get a hold.
    await fx.admin.query("SET session_replication_role = replica");
    try {
      await fx.admin.query(
        `INSERT INTO legal_holds (team_id, user_id, reason, status, placed_by, approved_by, approved_at, self_approved)
         VALUES ($1, $2, 'matter 148', 'active', $3, $3, now(), true)`,
        [w.team, w.alice.id, w.bob.id],
      );
    } finally {
      await fx.admin.query("SET session_replication_role = DEFAULT");
    }
    const res = await w.a.request("DELETE", "/v1/workspace/files?path=evidence.txt");
    expect(res.status).toBe(409);
    expect(workspaceFileErrorSchema.parse(res.json).code).toBe("read_only");
    expect((await w.a.get("/v1/workspace/file?path=evidence.txt")).text).toBe("keep me");
    expect(await auditRows(w.team, "workspace.file_deleted")).toEqual([]);
  });

  it("requires the team header on changes (multi-tab guard)", async () => {
    const w = await world();
    const stray = new TestBrowser(app, PUBLIC_URL);
    for (const [k, v] of w.alice.browser.cookies) stray.cookies.set(k, v);
    expect((await stray.request("DELETE", "/v1/workspace/files?path=a")).status).toBe(400);
  });
});

describe("POST /v1/workspace/wake", () => {
  it("asks the lifecycle to wake the caller's own sandbox and answers at once", async () => {
    const w = await world();
    const res = await w.a.post("/v1/workspace/wake");
    expect(res.status).toBe(202);
    expect(woken.at(-1)).toEqual({ teamId: w.team, userId: w.alice.id });
    await w.b.post("/v1/workspace/wake");
    expect(woken.at(-1)).toEqual({ teamId: w.team, userId: w.bob.id });
  });
});

describe("without object storage", () => {
  it("answers 503 sandbox_unavailable on every route", async () => {
    const w = await world();
    const bare = createApp(fx.replica(0).deps);
    const b = new TestBrowser(bare, PUBLIC_URL);
    for (const [k, v] of w.alice.browser.cookies) b.cookies.set(k, v);
    b.team = w.team;
    for (const res of [
      await b.get("/v1/workspace/files"),
      await b.get("/v1/workspace/file?path=a"),
      await b.post("/v1/workspace/wake"),
    ]) {
      expect(res.status).toBe(503);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("sandbox_unavailable");
    }
  });
});
