import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceFileEntrySchema, workspaceSaveConflictSchema } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { createApp } from "./app.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RawBody, TestBrowser } from "./testing/browser.js";
import { currentEntry } from "./workspace-sync/store.js";
import {
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * KOBE-462 (spec FE4/FE5): `PUT /v1/workspace/file` against a real Postgres: the version check,
 * unchanged saves, limits and quotas, read-only and internal paths, other members, the audit and
 * a save racing an agent's push.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 64 * 1024, maxWorkspaceBytes: 128 * 1024, maxFiles: 50 };
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await fx.setup([{}]);
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } },
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

function browserFor(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

async function world(): Promise<World> {
  const alice = await fx.person("alice");
  const bob = await fx.person("bob");
  const team = await fx.team(`sv-${randomBytes(3).toString("hex")}`, alice, [bob]);
  return { team, alice, bob, a: browserFor(alice, team), b: browserFor(bob, team) };
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function seed(
  w: World,
  who: Person,
  path: string,
  content: string,
  area: "user" | "projects" = "user",
): Promise<string> {
  const data = Buffer.from(content);
  const owner = { teamId: w.team, userId: who.id };
  const hash = sha(data);
  const key =
    area === "user" ? workspaceBlobKey("", owner, hash) : `teams/${w.team}/${area}/${randomUUID()}`;
  objects.objects.set(key, data);
  await withTeam(fx.db, w.team, (tx) =>
    sync.putServerFile(tx, owner, { path, sha256: hash, size: data.length, blobKey: key }, area),
  );
  return hash;
}

const save = (b: TestBrowser, path: string, base: string, content: string | Uint8Array) =>
  b.put(
    `/v1/workspace/file?path=${encodeURIComponent(path)}&base_sha256=${base}`,
    new RawBody(content, "text/plain; charset=utf-8"),
  );

const entryOf = (w: World, who: Person, path: string) =>
  withTeam(fx.db, w.team, (tx) => currentEntry(tx, { teamId: w.team, userId: who.id }, path));

async function auditRows(team: string, action: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

describe("PUT /v1/workspace/file (KOBE-462)", () => {
  it("replaces the file when the base still matches: a new server revision, audited", async () => {
    const w = await world();
    const base = await seed(w, w.alice, "notes/plan.md", "# Plan\n");
    const before = await entryOf(w, w.alice, "notes/plan.md");
    const res = await save(w.a, "notes/plan.md", base, "# Plan\n\nShip it.\n");
    expect(res.status).toBe(200);
    const entry = workspaceFileEntrySchema.parse(res.json);
    expect(entry.sha256).toBe(sha("# Plan\n\nShip it.\n"));
    expect(entry.path).toBe("notes/plan.md");
    const after = await entryOf(w, w.alice, "notes/plan.md");
    expect(after?.rev).toBeGreaterThan(before?.rev ?? 0);
    expect(after?.origin).toBe("server");
    expect(objects.objects.get(after?.blobKey ?? "")?.toString()).toBe("# Plan\n\nShip it.\n");
    expect(await auditRows(w.team, "workspace.file_saved")).toEqual([
      { userId: w.alice.id, bytes: Buffer.byteLength("# Plan\n\nShip it.\n") },
    ]);
  });

  it("answers 409 with the current version when the file changed since it was loaded", async () => {
    const w = await world();
    const old = await seed(w, w.alice, "a.md", "one\n");
    // The agent changed the file meanwhile (its push reached the synced copy first).
    const now = await seed(w, w.alice, "a.md", "two\n");
    const res = await save(w.a, "a.md", old, "mine\n");
    expect(res.status).toBe(409);
    const body = workspaceSaveConflictSchema.parse(res.json);
    expect(body.current?.sha256).toBe(now);
    expect(body.current?.size_bytes).toBe(4);
    expect((await entryOf(w, w.alice, "a.md"))?.sha256).toBe(now);
    expect(await auditRows(w.team, "workspace.file_saved")).toEqual([]);
  });

  it("answers 409 with no current version for a deleted or unknown file", async () => {
    const w = await world();
    const base = await seed(w, w.alice, "gone.md", "x\n");
    expect((await w.a.delete("/v1/workspace/files?path=gone.md")).status).toBe(204);
    const deleted = await save(w.a, "gone.md", base, "y\n");
    expect(deleted.status).toBe(409);
    expect(workspaceSaveConflictSchema.parse(deleted.json).current).toBeNull();
    const unknown = await save(w.a, "never.md", base, "y\n");
    expect(unknown.status).toBe(409);
    expect(workspaceSaveConflictSchema.parse(unknown.json).current).toBeNull();
  });

  it("writes nothing for unchanged content", async () => {
    const w = await world();
    const base = await seed(w, w.alice, "same.md", "same\n");
    const rev = (await entryOf(w, w.alice, "same.md"))?.rev;
    const res = await save(w.a, "same.md", base, "same\n");
    expect(res.status).toBe(200);
    expect(workspaceFileEntrySchema.parse(res.json).sha256).toBe(base);
    expect((await entryOf(w, w.alice, "same.md"))?.rev).toBe(rev);
    expect(await auditRows(w.team, "workspace.file_saved")).toEqual([]);
  });

  it("works on the caller's own workspace only", async () => {
    const w = await world();
    const base = await seed(w, w.alice, "mine.md", "alice\n");
    const res = await save(w.b, "mine.md", base, "bob was here\n");
    expect(res.status).toBe(409);
    expect((await entryOf(w, w.alice, "mine.md"))?.sha256).toBe(base);
    expect(await entryOf(w, w.bob, "mine.md")).toBeUndefined();
  });

  it("refuses read-only areas, agent-internal paths and bad queries", async () => {
    const w = await world();
    const base = await seed(w, w.alice, "projects/p/spec.md", "spec\n", "projects");
    expect((await save(w.a, "projects/p/spec.md", base, "x")).status).toBe(403);
    expect((await save(w.a, "uploads/thread-1/a.txt", base, "x")).status).toBe(403);
    expect((await save(w.a, ".kobe/state.json", base, "x")).status).toBe(404);
    expect(
      (await w.a.put("/v1/workspace/file?path=a.md", new RawBody("x", "text/plain"))).status,
    ).toBe(400);
    expect((await save(w.a, "../a.md", base, "x")).status).toBe(400);
  });

  it("keeps the upload's size limit and the workspace and team quotas", async () => {
    const w = await world();
    const base = await seed(w, w.alice, "big.md", "small\n");
    const tooBig = await save(w.a, "big.md", base, "x".repeat(LIMITS.maxFileBytes + 1));
    expect(tooBig.status).toBe(413);
    // Fill the workspace close to its limit, then grow the file past it.
    await seed(w, w.alice, "filler-1.bin", "f".repeat(60 * 1024));
    await seed(w, w.alice, "filler-2.bin", "g".repeat(60 * 1024));
    const over = await save(w.a, "big.md", base, "y".repeat(10 * 1024));
    expect(over.status).toBe(507);
    // Shrinking is always allowed, even with the team over its storage limit.
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, 10, $2)`,
      [w.team, w.alice.id],
    );
    const filler = await entryOf(w, w.alice, "filler-1.bin");
    expect((await save(w.a, "filler-1.bin", filler?.sha256 ?? "", "tiny")).status).toBe(200);
    const grow = await entryOf(w, w.alice, "big.md");
    expect((await save(w.a, "big.md", grow?.sha256 ?? "", "z".repeat(100))).status).toBe(507);
  });

  it("keeps the executable bit and lets two racing saves of one base land once", async () => {
    const w = await world();
    const data = Buffer.from("#!/bin/sh\necho hi\n");
    const owner = { teamId: w.team, userId: w.alice.id };
    const key = workspaceBlobKey("", owner, sha(data));
    objects.objects.set(key, data);
    await withTeam(fx.db, w.team, (tx) =>
      sync.putServerFile(
        tx,
        owner,
        { path: "run.sh", sha256: sha(data), size: data.length, blobKey: key, executable: true },
        "user",
      ),
    );
    const results = await Promise.all([
      save(w.a, "run.sh", sha(data), "#!/bin/sh\necho one\n"),
      save(w.a, "run.sh", sha(data), "#!/bin/sh\necho two\n"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await entryOf(w, w.alice, "run.sh"))?.executable).toBe(true);
  });
});
