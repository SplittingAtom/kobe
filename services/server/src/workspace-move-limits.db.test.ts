import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mentionMarker,
  workspaceFileErrorSchema,
  workspaceListResponseSchema,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { createApp } from "./app.js";
import { MOVE_BUDGET } from "./routes/workspace-move.js";
import { SANDBOX_CHANNEL } from "./sandbox-wire/constants.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RawBody, TestBrowser } from "./testing/browser.js";
import { movesSince } from "./workspace-sync/move-journal.js";
import {
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * KOBE-304 review: the move API's limits and edges against a real Postgres (the main cases are in
 * workspace-move.db.test.ts): the journal the sandbox replays, the nudge to an awake sandbox, the
 * per-member files/bytes budget, idempotent retries, too many files, no room, the lock timeout,
 * body limits, other teams, non-ASCII and NFC/NFD names, literal percent signs, and a schedule
 * whose prompt would outgrow its limit.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await fx.setup([{}]);
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() }, moveLockTimeoutMs: 300 },
  });
});

afterAll(() => fx.teardown());

interface World {
  readonly team: string;
  readonly alice: Person;
  readonly a: TestBrowser;
}

function browserFor(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

async function world(): Promise<World> {
  const alice = await fx.person("alice");
  const team = await fx.team(`ml-${randomBytes(3).toString("hex")}`, alice);
  return { team, alice, a: browserFor(alice, team) };
}

const sha = (data: string) => createHash("sha256").update(data).digest("hex");

async function seed(w: World, path: string, content = "x", who = w.alice, team = w.team) {
  const owner = { teamId: team, userId: who.id };
  const hash = sha(content);
  const key = workspaceBlobKey("", owner, hash);
  objects.objects.set(key, Buffer.from(content));
  await withTeam(fx.db, team, (tx) =>
    sync.putServerFile(
      tx,
      owner,
      { path, sha256: hash, size: content.length, blobKey: key },
      "user",
    ),
  );
}

/** Many live rows at once, straight into the manifest (no objects: nothing reads them here). */
async function seedMany(w: World, folder: string, n: number) {
  await fx.admin.query(
    `INSERT INTO workspace_sync (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [w.team, w.alice.id],
  );
  const { rows } = await fx.admin.query<{ head_rev: string }>(
    `SELECT head_rev FROM workspace_sync WHERE team_id = $1 AND user_id = $2`,
    [w.team, w.alice.id],
  );
  const head = Number(rows[0]?.head_rev ?? 0);
  await fx.admin.query(
    `INSERT INTO workspace_files (team_id, user_id, path, rev, sha256, blob_key, size, mtime_ms, origin)
     SELECT $1, $2, $3 || '/f' || i, $4 + i, repeat('a', 64), 'k', 1, 0, 'server'
       FROM generate_series(1, $5) AS i`,
    [w.team, w.alice.id, folder, head, n],
  );
  await fx.admin.query(
    `UPDATE workspace_sync SET head_rev = head_rev + $3, live_files = live_files + $3,
            live_bytes = live_bytes + $3
      WHERE team_id = $1 AND user_id = $2`,
    [w.team, w.alice.id, n],
  );
}

const move = (b: TestBrowser, from: string, to: string) =>
  b.post("/v1/workspace/files/move", { from, to });
const code = (res: { json: unknown }) => workspaceFileErrorSchema.parse(res.json).code;
const names = async (b: TestBrowser, path = "") =>
  workspaceListResponseSchema
    .parse(
      (await b.get(`/v1/workspace/files${path === "" ? "" : `?path=${encodeURIComponent(path)}`}`))
        .json,
    )
    .entries.map((e) => e.name);
const audits = async (team: string) =>
  (
    await fx.admin.query(
      `SELECT 1 FROM audit_log WHERE team_id = $1 AND action = 'workspace.file_moved'`,
      [team],
    )
  ).rowCount;

describe("the move journal the sandbox replays (KOBE-304 review S1–S3)", () => {
  it("records each move with its first revision; lists those with rows newer than `since`", async () => {
    const w = await world();
    await seed(w, "a/x.txt");
    await seed(w, "a/y.txt");
    await seed(w, "b.txt");
    const owner = { teamId: w.team, userId: w.alice.id };
    expect((await move(w.a, "a", "c/a")).status).toBe(200);
    expect((await move(w.a, "b.txt", "c/b.txt")).status).toBe(200);
    const all = await withTeam(fx.db, w.team, (tx) => movesSince(tx, owner, 0));
    expect(all).toEqual({
      moves: [
        { rev: 4, from: "a", to: "c/a", type: "dir" },
        { rev: 8, from: "b.txt", to: "c/b.txt", type: "file" },
      ],
      more: false,
    });
    // A pull that saw part of the first move's rows still gets it; after the second, nothing.
    const mid = await withTeam(fx.db, w.team, (tx) => movesSince(tx, owner, 5));
    expect(mid.moves.map((m) => m.rev)).toEqual([4, 8]);
    expect((await withTeam(fx.db, w.team, (tx) => movesSince(tx, owner, 9))).moves).toEqual([]);
    expect((await withTeam(fx.db, w.team, (tx) => movesSince(tx, owner, 0, 4))).moves).toHaveLength(
      1,
    );
    // Another member's journal is not theirs.
    const bob = await fx.person("bob");
    expect(
      (await withTeam(fx.db, w.team, (tx) => movesSince(tx, { teamId: w.team, userId: bob.id }, 0)))
        .moves,
    ).toEqual([]);
  });

  it("hints the replica holding an awake sandbox's socket, on commit", async () => {
    const w = await world();
    await seed(w, "a.txt");
    const connectionId = randomUUID();
    await fx.admin.query(
      `INSERT INTO sandbox_connections (team_id, user_id, sandbox_id, connection_id, replica_id)
       VALUES ($1, $2, $3, $4, 'r')`,
      [w.team, w.alice.id, randomUUID(), connectionId],
    );
    const listener = new pg.Client({ connectionString: fx.database.adminUrl });
    await listener.connect();
    const hints: string[] = [];
    listener.on("notification", (n) => hints.push(n.payload ?? ""));
    await listener.query(`LISTEN ${SANDBOX_CHANNEL}`);
    try {
      expect((await move(w.a, "a.txt", "b.txt")).status).toBe(200);
      for (let i = 0; i < 50 && !hints.includes(`mv:${connectionId}`); i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(hints).toContain(`mv:${connectionId}`);
    } finally {
      await listener.end();
    }
  });
});

describe("limits (KOBE-304 review)", () => {
  it("meters files and bytes per member besides the count of moves", async () => {
    const w = await world();
    await seed(w, "a.txt");
    await fx.admin.query(
      `INSERT INTO workspace_moves (team_id, user_id, rev, from_path, to_path, type, files, bytes)
       VALUES ($1, $2, 100000, 'x', 'y', 'dir', $3, 1)`,
      [w.team, w.alice.id, MOVE_BUDGET.files],
    );
    const res = await move(w.a, "a.txt", "b.txt");
    expect(res.status).toBe(429);
    expect((res.json as { code: string }).code).toBe("rate_limited");
    await fx.admin.query(
      `UPDATE workspace_moves SET created_at = now() - interval '2 minutes' WHERE team_id = $1`,
      [w.team],
    );
    expect((await move(w.a, "a.txt", "b.txt")).status).toBe(200);
  });

  it("a retry of a move that happened answers as the move did, once audited", async () => {
    const w = await world();
    await seed(w, "d/x.txt");
    const first = await move(w.a, "d", "e");
    const again = await move(w.a, "d", "e");
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    expect(await audits(w.team)).toBe(1);
    // Moved back since: a stale retry is not a success.
    expect((await move(w.a, "e", "d")).status).toBe(200);
    expect((await move(w.a, "nothing", "e")).status).toBe(404);
  });

  it("refuses a folder of more than 10 000 files (422) and one that would exceed the row cap (507)", async () => {
    const w = await world();
    await seedMany(w, "huge", 10_001);
    const many = await move(w.a, "huge", "big");
    expect(many.status).toBe(422);
    expect(code(many)).toBe("invalid_path");
    const v = await world();
    await seedMany({ ...v }, "folder", 60); // 60 live rows; the cap is 2 × 50
    const full = await move(v.a, "folder", "moved");
    expect(full.status).toBe(507);
    expect(code(full)).toBe("quota_exceeded");
  });

  it("gives up waiting for a busy workspace with 503 and Retry-After", async () => {
    const w = await world();
    await seed(w, "a.txt");
    const holder = new pg.Client({ connectionString: fx.database.adminUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT 1 FROM workspace_sync WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
        [w.team, w.alice.id],
      );
      const res = await move(w.a, "a.txt", "b.txt");
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("2");
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect((await move(w.a, "a.txt", "b.txt")).status).toBe(200);
  });

  it("refuses a body over 16 KiB (413) and malformed JSON (400)", async () => {
    const w = await world();
    const big = await w.a.post("/v1/workspace/files/move", {
      from: "a",
      to: "b",
      pad: "x".repeat(17_000),
    });
    expect(big.status).toBe(413);
    const bad = await w.a.request(
      "POST",
      "/v1/workspace/files/move",
      new RawBody(Buffer.from("{nope"), "application/json"),
    );
    expect(bad.status).toBe(400);
  });

  it("works in the team the request names only, for a member of two teams", async () => {
    const w = await world();
    const other = await fx.team(`ml2-${randomBytes(3).toString("hex")}`, w.alice);
    await seed(w, "a.txt", "team A");
    const inB = browserFor(w.alice, other);
    expect((await move(inB, "a.txt", "b.txt")).status).toBe(404);
    const { rows } = await fx.admin.query<{ path: string }>(
      `SELECT path FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND NOT deleted`,
      [w.team, w.alice.id],
    );
    expect(rows).toEqual([{ path: "a.txt" }]);
  });
});

describe("names (KOBE-304 review)", () => {
  it("moves non-ASCII folders exactly (code points, not bytes)", async () => {
    const w = await world();
    await seed(w, "café/naïve 🎉.txt", "ok");
    await seed(w, "café/日本/文書.md", "doc");
    expect((await move(w.a, "café", "archivé/café ☕")).status).toBe(200);
    expect(await names(w.a, "archivé/café ☕")).toEqual(["日本", "naïve 🎉.txt"]);
    expect(
      (
        await w.a.get(
          `/v1/workspace/file?path=${encodeURIComponent("archivé/café ☕/日本/文書.md")}`,
        )
      ).text,
    ).toBe("doc");
  });

  it("refuses a new name that equals a sibling's once both are NFC", async () => {
    const w = await world();
    await seed(w, "café.txt");
    await seed(w, "x.txt");
    const res = await move(w.a, "x.txt", "café.txt");
    expect(res.status).toBe(409);
    expect(code(res)).toBe("already_exists");
    // Renaming a name to its own composed form is not a clash with itself.
    await seed(w, "naïve.txt");
    expect((await move(w.a, "naïve.txt", "naïve.txt")).status).toBe(200);
  });

  it("takes percent signs literally", async () => {
    const w = await world();
    await seed(w, "a.txt");
    expect((await move(w.a, "a.txt", "%2e%2e/a.txt")).status).toBe(200);
    expect(await names(w.a)).toEqual(["%2e%2e"]);
  });

  it("says to rename first when a moved file's own name breaks the rules", async () => {
    const w = await world();
    await seed(w, "price $5.txt");
    const res = await move(w.a, "price $5.txt", "dir/price $5.txt");
    expect(res.status).toBe(400);
    expect((res.json as { message: string }).message).toMatch(/Rename it first/);
  });

  it("leaves a schedule unchanged when its rewritten prompt would outgrow 10 000 characters", async () => {
    const w = await world();
    await seed(w, "a.csv");
    const prompt = `${"p".repeat(10_000 - mentionMarker("a.csv").length)}${mentionMarker("a.csv")}`;
    const id = randomUUID();
    await fx.admin.query(
      `INSERT INTO schedules (team_id, id, user_id, agent_id, prompt, mentions, recurrence, tz, active, next_due_at)
       VALUES ($1, $2, $3, $4, $5, '{a.csv}', '{"kind":"daily","at":"09:00"}', 'UTC', true, now())`,
      [w.team, id, w.alice.id, randomUUID(), prompt],
    );
    expect((await move(w.a, "a.csv", "a-much-longer-name.csv")).status).toBe(200);
    const { rows } = await fx.admin.query<{ prompt: string; mentions: string[] }>(
      `SELECT prompt, mentions FROM schedules WHERE team_id = $1 AND id = $2`,
      [w.team, id],
    );
    expect(rows[0]).toEqual({ prompt, mentions: ["a.csv"] });
  });
});
