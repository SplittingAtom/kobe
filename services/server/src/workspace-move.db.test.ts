import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mentionMarker,
  workspaceFileErrorSchema,
  workspaceListResponseSchema,
  workspaceMoveResponseSchema,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { createApp } from "./app.js";
import { hitRateLimit } from "./rate-limit.js";
import { purgeReleasedWorkspaceHoldHistory } from "./retention/workspace-hold-history.js";
import { MOVE_RATE_LIMIT } from "./routes/workspace-move.js";
import { rewriteMentions } from "./runs/mentions.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { TestBrowser } from "./testing/browser.js";
import { manifestPage } from "./workspace-sync/store.js";
import {
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * KOBE-304: `POST /v1/workspace/files/move` against a real Postgres: the manifest-first move, the
 * path rules, clashes, read-only areas, other members, the silent legal hold, the audit, the rate
 * limit and the references that follow a moved file (schedules) or refuse clearly (drafts).
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
  const team = await fx.team(`mv-${randomBytes(3).toString("hex")}`, alice, [bob]);
  return { team, alice, bob, a: browserFor(alice, team), b: browserFor(bob, team) };
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

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

const move = (b: TestBrowser, from: string, to: string) =>
  b.post("/v1/workspace/files/move", { from, to });

async function names(b: TestBrowser, path = ""): Promise<string[]> {
  const res = await b.get(
    `/v1/workspace/files${path === "" ? "" : `?path=${encodeURIComponent(path)}`}`,
  );
  if (res.status === 404) return [];
  return workspaceListResponseSchema.parse(res.json).entries.map((e) => e.name);
}

async function auditRows(team: string, action: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

async function syncState(w: World, who: Person) {
  const { rows } = await fx.admin.query<{
    head_rev: string;
    live_files: number;
    live_bytes: string;
    tombstones: number;
  }>(
    `SELECT head_rev, live_files, live_bytes, tombstones FROM workspace_sync
      WHERE team_id = $1 AND user_id = $2`,
    [w.team, who.id],
  );
  const s = rows[0];
  return {
    headRev: Number(s?.head_rev ?? 0),
    liveFiles: s?.live_files ?? 0,
    liveBytes: Number(s?.live_bytes ?? 0),
    tombstones: s?.tombstones ?? 0,
  };
}

/** The counters as the rows say they should be (what a collection pass would recompute). */
async function countedFromRows(w: World, who: Person) {
  const { rows } = await fx.admin.query<{ live: string; dead: string; bytes: string }>(
    `SELECT count(*) FILTER (WHERE NOT deleted) AS live, count(*) FILTER (WHERE deleted) AS dead,
            COALESCE(sum(size) FILTER (WHERE NOT deleted), 0) AS bytes
       FROM workspace_files WHERE team_id = $1 AND user_id = $2`,
    [w.team, who.id],
  );
  const r = rows[0];
  return { live: Number(r?.live), dead: Number(r?.dead), bytes: Number(r?.bytes) };
}

async function holdOn(w: World, who: Person | null): Promise<string> {
  // The two-person flow has its own tests (KOBE-17); the guard trigger is bypassed to get a hold.
  await fx.admin.query("SET session_replication_role = replica");
  try {
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, status, placed_by, approved_by, approved_at, self_approved)
       VALUES ($1, $2, 'matter 304', 'active', $3, $3, now(), true) RETURNING id`,
      [w.team, who?.id ?? null, w.bob.id],
    );
    return rows[0]?.id ?? "";
  } finally {
    await fx.admin.query("SET session_replication_role = DEFAULT");
  }
}

async function releaseHold(w: World, id: string): Promise<void> {
  await fx.admin.query("SET session_replication_role = replica");
  try {
    await fx.admin.query(
      `UPDATE legal_holds
          SET status = 'released', released_by = $2, released_at = now(),
              release_requested_by = $3, release_requested_at = now(), release_reason = 'done'
        WHERE id = $1`,
      [id, w.bob.id, w.alice.id],
    );
  } finally {
    await fx.admin.query("SET session_replication_role = DEFAULT");
  }
}

const code = (res: { json: unknown }) => workspaceFileErrorSchema.parse(res.json).code;

describe("POST /v1/workspace/files/move (KOBE-304, ac-8)", () => {
  it("renames a file: the new path has the content, the old one is gone", async () => {
    const w = await world();
    await seed(w, w.alice, "notes/a.md", "hello");
    const before = await syncState(w, w.alice);
    const res = await move(w.a, "notes/a.md", "notes/b.md");
    expect(res.status, res.text).toBe(200);
    expect(workspaceMoveResponseSchema.parse(res.json)).toEqual({
      from: "notes/a.md",
      to: "notes/b.md",
      type: "file",
      files: 1,
    });
    expect(await names(w.a, "notes")).toEqual(["b.md"]);
    expect((await w.a.get("/v1/workspace/file?path=notes/b.md")).text).toBe("hello");
    expect((await w.a.get("/v1/workspace/file?path=notes/a.md")).status).toBe(404);
    const after = await syncState(w, w.alice);
    expect(after).toEqual({ ...before, headRev: before.headRev + 2, tombstones: 1 });
    // Counts and bytes only, never a name.
    const audit = await auditRows(w.team, "workspace.file_moved");
    expect(audit).toEqual([{ userId: w.alice.id, files: 1, bytes: 5 }]);
    expect(JSON.stringify(audit)).not.toMatch(/notes|\.md/);
  });

  it("moves a folder with everything in it, keeping each file's content and mode", async () => {
    const w = await world();
    for (const [p, c] of [
      ["reports/q1.csv", "1"],
      ["reports/2026/q2.csv", "22"],
      ["reports/2026/deep/q3.csv", "333"],
      ["reportsX/keep.txt", "k"],
    ] as const) {
      await seed(w, w.alice, p, c);
    }
    await seed(w, w.alice, "archive/old.txt", "o");
    const res = await move(w.a, "reports", "archive/reports");
    expect(res.status, res.text).toBe(200);
    expect(workspaceMoveResponseSchema.parse(res.json)).toMatchObject({ type: "dir", files: 3 });
    expect(await names(w.a)).toEqual(["archive", "reportsX"]);
    expect(await names(w.a, "archive/reports/2026")).toEqual(["deep", "q2.csv"]);
    expect((await w.a.get("/v1/workspace/file?path=archive/reports/2026/deep/q3.csv")).text).toBe(
      "333",
    );
    expect(await auditRows(w.team, "workspace.file_moved")).toEqual([
      { userId: w.alice.id, files: 3, bytes: 6 },
    ]);
    const counted = await countedFromRows(w, w.alice);
    const state = await syncState(w, w.alice);
    expect({ live: state.liveFiles, dead: state.tombstones, bytes: state.liveBytes }).toEqual(
      counted,
    );
  });

  it("is manifest-first: a sandbox pull sees the new rows, then the tombstones", async () => {
    const w = await world();
    await seed(w, w.alice, "d/x.txt", "x");
    await seed(w, w.alice, "d/y.txt", "y");
    const owner = { teamId: w.team, userId: w.alice.id };
    const { headRev } = await syncState(w, w.alice);
    expect((await move(w.a, "d", "e")).status).toBe(200);
    const page = await withTeam(fx.db, w.team, (tx) => manifestPage(tx, owner, headRev, 100));
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.entries.map((e) => [e.path, e.deleted, e.origin])).toEqual([
      ["e/x.txt", false, "server"],
      ["e/y.txt", false, "server"],
      ["d/x.txt", true, "server"],
      ["d/y.txt", true, "server"],
    ]);
    // Same content, same object: nothing was copied in storage.
    const [x] = page.entries;
    expect(x?.blobKey).toBe(workspaceBlobKey("", owner, sha(Buffer.from("x"))));
  });

  it("reuses a tombstone at the new path (moving back and forth keeps the counters exact)", async () => {
    const w = await world();
    await seed(w, w.alice, "a.txt", "a");
    expect((await move(w.a, "a.txt", "b.txt")).status).toBe(200);
    expect((await move(w.a, "b.txt", "a.txt")).status).toBe(200);
    expect((await move(w.a, "a.txt", "b.txt")).status).toBe(200);
    const state = await syncState(w, w.alice);
    expect({ live: state.liveFiles, dead: state.tombstones, bytes: state.liveBytes }).toEqual(
      await countedFromRows(w, w.alice),
    );
    expect(state.tombstones).toBe(1);
  });

  it("refuses a name clash, never overwriting", async () => {
    const w = await world();
    await seed(w, w.alice, "a.txt", "mine");
    await seed(w, w.alice, "b.txt", "theirs");
    await seed(w, w.alice, "dir/inner.txt", "i");
    await seed(w, w.alice, "file", "f");
    for (const [from, to] of [
      ["a.txt", "b.txt"], // a file there
      ["a.txt", "dir"], // a folder there
      ["a.txt", "file/a.txt"], // a file where a folder would be
      ["dir", "b.txt"],
    ] as const) {
      const res = await move(w.a, from, to);
      expect(res.status, `${from} -> ${to}`).toBe(409);
      expect(code(res)).toBe("already_exists");
    }
    expect((await w.a.get("/v1/workspace/file?path=b.txt")).text).toBe("theirs");
    expect((await w.a.get("/v1/workspace/file?path=a.txt")).text).toBe("mine");
    expect(await auditRows(w.team, "workspace.file_moved")).toEqual([]);
  });

  it("refuses moving onto itself or into itself", async () => {
    const w = await world();
    await seed(w, w.alice, "dir/sub/x", "x");
    for (const [from, to] of [
      ["dir", "dir"],
      ["dir", "dir/sub/dir"],
      ["dir/sub", "dir/sub/inner"],
    ] as const) {
      const res = await move(w.a, from, to);
      expect(res.status, `${from} -> ${to}`).toBe(400);
      expect(code(res)).toBe("invalid_path");
    }
    // Into its own parent's parent is fine, but onto its parent clashes.
    expect((await move(w.a, "dir/sub", "dir")).status).toBe(409);
    expect((await move(w.a, "dir/sub", "sub")).status).toBe(200);
  });

  it("applies the KOBE-223 path rules to the new path", async () => {
    const w = await world();
    await seed(w, w.alice, "a.txt", "a");
    for (const to of [
      "../a.txt",
      "/etc/a.txt",
      "x/./a.txt",
      "x//a.txt",
      "a\u0000.txt",
      "a‮.txt", // bidi override
      "a​.txt", // zero width space
      "a .txt", // no-break space
      "a\u{e0041}.txt", // tag character
      "a$b.txt",
      "a;b.txt",
      "a`b.txt",
      "back\\slash",
      `${"n".repeat(256)}.txt`,
      `${"d/".repeat(600)}a.txt`,
      ".kobe/a.txt",
      ".kobe",
    ]) {
      const res = await move(w.a, "a.txt", to);
      expect(res.status, JSON.stringify(to)).toBe(400);
      expect(code(res)).toBe("invalid_path");
    }
    expect((await w.a.post("/v1/workspace/files/move", { from: "a.txt" })).status).toBe(400);
    expect(
      (await w.a.post("/v1/workspace/files/move", { from: "a.txt", to: "b", force: true })).status,
    ).toBe(400);
    // Agent-internal files stay hidden: not found, as in the listing.
    expect((await move(w.a, ".kobe/session.jsonl", "s.jsonl")).status).toBe(404);
    expect((await w.a.get("/v1/workspace/file?path=a.txt")).text).toBe("a");
  });

  it("refuses a move whose files would get too long a path", async () => {
    const w = await world();
    const deep = `${"d".repeat(200)}/${"e".repeat(200)}/${"f".repeat(200)}/${"g".repeat(200)}/x`;
    await seed(w, w.alice, `top/${deep}`, "x");
    const res = await move(w.a, "top", "t".repeat(250));
    expect(res.status).toBe(422);
    expect(code(res)).toBe("invalid_path");
  });

  it("keeps project mounts and thread uploads read-only; a member's drop may move", async () => {
    const w = await world();
    await seed(w, w.alice, "projects/plan/spec.md", "s", "projects");
    await seed(w, w.alice, `uploads/${randomUUID()}/brief.pdf`, "b", "uploads");
    await seed(w, w.alice, "uploads/dropped.pdf", "d");
    await seed(w, w.alice, "notes/n.txt", "n");
    await seed(w, w.alice, "folder/f.txt", "f");
    for (const [from, to] of [
      ["projects/plan/spec.md", "spec.md"],
      ["projects/plan", "plan"],
      ["projects", "p"],
      ["notes/n.txt", "projects/plan/n.txt"],
      ["notes/n.txt", "uploads"],
      ["notes/n.txt", `uploads/${randomUUID()}`],
      ["notes/n.txt", "uploads/x/n.txt"],
    ] as const) {
      const res = await move(w.a, from, to);
      expect(res.status, `${from} -> ${to}`).toBe(403);
      expect(code(res)).toBe("read_only");
    }
    // A folder can't become a drop (its files would land in thread-upload space).
    expect(code(await move(w.a, "folder", "uploads/folder"))).toBe("read_only");
    expect((await move(w.a, "uploads/dropped.pdf", "notes/dropped.pdf")).status).toBe(200);
    expect((await move(w.a, "notes/n.txt", "uploads/n.txt")).status).toBe(200);
    expect(await names(w.a, "notes")).toEqual(["dropped.pdf"]);
  });

  it("works on the caller's own workspace only", async () => {
    const w = await world();
    await seed(w, w.alice, "secret.txt", "alice only");
    await seed(w, w.bob, "mine.txt", "bob");
    expect((await move(w.b, "secret.txt", "taken.txt")).status).toBe(404);
    // A clash is judged in the caller's own workspace: alice's file is not in bob's way.
    expect((await move(w.b, "mine.txt", "secret.txt")).status).toBe(200);
    expect((await w.a.get("/v1/workspace/file?path=secret.txt")).text).toBe("alice only");
    expect(await names(w.a)).toEqual(["secret.txt"]);
    expect((await w.b.get("/v1/workspace/file?path=secret.txt")).text).toBe("bob");
  });

  it("answers the same under a legal hold, keeping the old paths aside", async () => {
    const w = await world();
    await seed(w, w.alice, "evidence/a.txt", "keep me");
    await seed(w, w.alice, "evidence/b.txt", "and me");
    await seed(w, w.bob, "evidence/a.txt", "bob's");
    await seed(w, w.bob, "evidence/b.txt", "bob's too");
    const hold = await holdOn(w, w.alice);
    const held = await move(w.a, "evidence", "case");
    const free = await move(w.b, "evidence", "case");
    expect(held.status).toBe(200);
    expect(held.json).toEqual(free.json);
    expect(held.headers.get("content-length")).toBe(free.headers.get("content-length"));
    expect((await w.a.get("/v1/workspace/file?path=case/a.txt")).text).toBe("keep me");
    expect((await auditRows(w.team, "workspace.file_moved")).length).toBe(2);
    const kept = await fx.admin.query<{
      user_id: string;
      path: string;
      moved_to: string;
      sha256: string;
    }>(
      `SELECT user_id, path, moved_to, sha256 FROM workspace_file_hold_history
        WHERE team_id = $1 ORDER BY path`,
      [w.team],
    );
    expect(kept.rows).toEqual([
      {
        user_id: w.alice.id,
        path: "evidence/a.txt",
        moved_to: "case/a.txt",
        sha256: sha(Buffer.from("keep me")),
      },
      {
        user_id: w.alice.id,
        path: "evidence/b.txt",
        moved_to: "case/b.txt",
        sha256: sha(Buffer.from("and me")),
      },
    ]);
    // Held: the retention pass keeps them; released: it purges them (count only).
    expect(await purgeReleasedWorkspaceHoldHistory(fx.db, w.team)).toEqual({ rows: 0 });
    await releaseHold(w, hold);
    expect(await purgeReleasedWorkspaceHoldHistory(fx.db, w.team)).toEqual({ rows: 2 });
    expect(await auditRows(w.team, "retention.workspace_hold_history_purged")).toEqual([
      { rows: 2 },
    ]);
  });

  it("a team-wide hold keeps every member's moved paths", async () => {
    const w = await world();
    await seed(w, w.bob, "x.txt", "x");
    const hold = await holdOn(w, null);
    expect((await move(w.b, "x.txt", "y.txt")).status).toBe(200);
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM workspace_file_hold_history WHERE team_id = $1 AND user_id = $2`,
      [w.team, w.bob.id],
    );
    expect(rows).toHaveLength(1);
    await releaseHold(w, hold);
  });

  it("is rate limited per member", async () => {
    const w = await world();
    await seed(w, w.alice, "a.txt", "a");
    for (let i = 0; i < MOVE_RATE_LIMIT.max; i += 1) {
      await hitRateLimit(fx.db, `workspace-move:${w.alice.id}`, MOVE_RATE_LIMIT);
    }
    const res = await move(w.a, "a.txt", "b.txt");
    expect(res.status).toBe(429);
    expect((res.json as { code: string }).code).toBe("rate_limited");
    expect((await move(w.b, "nothing", "else")).status).toBe(404); // bob has his own budget
  });

  it("requires the team header (multi-tab guard)", async () => {
    const w = await world();
    await seed(w, w.alice, "a.txt", "a");
    const stray = new TestBrowser(app, PUBLIC_URL);
    for (const [k, v] of w.alice.browser.cookies) stray.cookies.set(k, v);
    expect((await move(stray, "a.txt", "b.txt")).status).toBeGreaterThanOrEqual(400);
    expect(await names(w.a)).toEqual(["a.txt"]);
  });
});

describe("references to a moved file (KOBE-304, ac-9)", () => {
  async function schedule(w: World, who: Person, prompt: string, mentions: string[]) {
    const id = randomUUID();
    await fx.admin.query(
      `INSERT INTO schedules (team_id, id, user_id, agent_id, prompt, mentions, recurrence, tz, active, next_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{"kind":"daily","at":"09:00"}', 'UTC', true, now())`,
      [w.team, id, who.id, randomUUID(), prompt, mentions],
    );
    return id;
  }
  async function scheduleRow(w: World, id: string) {
    const { rows } = await fx.admin.query<{ prompt: string; mentions: string[] }>(
      `SELECT prompt, mentions FROM schedules WHERE team_id = $1 AND id = $2`,
      [w.team, id],
    );
    return rows[0];
  }

  it("the owner's schedules follow the move; other members' are untouched", async () => {
    const w = await world();
    await seed(w, w.alice, "data/sales.csv", "1");
    await seed(w, w.alice, "data/other.csv", "2");
    await seed(w, w.bob, "data/sales.csv", "b");
    const prompt = `Sum ${mentionMarker("data/sales.csv")} and ${mentionMarker("data/other.csv")}`;
    const mine = await schedule(w, w.alice, prompt, ["data/sales.csv", "data/other.csv"]);
    const theirs = await schedule(w, w.bob, `See ${mentionMarker("data/sales.csv")}`, [
      "data/sales.csv",
    ]);
    expect((await move(w.a, "data", "archive/data 2026")).status).toBe(200);
    expect(await scheduleRow(w, mine)).toEqual({
      prompt: `Sum ${mentionMarker("archive/data 2026/sales.csv")} and ${mentionMarker("archive/data 2026/other.csv")}`,
      mentions: ["archive/data 2026/sales.csv", "archive/data 2026/other.csv"],
    });
    expect(await scheduleRow(w, theirs)).toEqual({
      prompt: `See ${mentionMarker("data/sales.csv")}`,
      mentions: ["data/sales.csv"],
    });
    // The moved schedule's mentions resolve at its next run.
    const row = await scheduleRow(w, mine);
    const out = await withTeam(fx.db, w.team, (tx) =>
      rewriteMentions(
        tx,
        { teamId: w.team, userId: w.alice.id },
        row?.prompt ?? "",
        row?.mentions ?? [],
        "keep",
      ),
    );
    expect(out).toEqual({
      text: "Sum /workspace/archive/data 2026/sales.csv and /workspace/archive/data 2026/other.csv".replace(
        /\/workspace\/archive\/data 2026\/(\w+)\.csv/g,
        (m) => `\`${m}\``,
      ),
      skipped: 0,
    });
  });

  it("a draft that still mentions the old path is refused with a clear message", async () => {
    const w = await world();
    await seed(w, w.alice, "a.csv", "1");
    expect((await move(w.a, "a.csv", "b.csv")).status).toBe(200);
    const owner = { teamId: w.team, userId: w.alice.id };
    await expect(
      withTeam(fx.db, w.team, (tx) =>
        rewriteMentions(tx, owner, mentionMarker("a.csv"), ["a.csv"]),
      ),
    ).rejects.toThrow(/There is no file a\.csv in your workspace/);
  });
});
