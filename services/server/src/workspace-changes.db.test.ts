import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceFileChangeSchema, type WorkspaceFileChange } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { createApp } from "./app.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RawBody, TestBrowser } from "./testing/browser.js";
import { SseReader } from "./testing/sse.js";
import { commitChanges, currentEntry, recordBlob } from "./workspace-sync/store.js";
import {
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * KOBE-496: `GET /v1/workspace/changes` against a real Postgres. A change reaches the member's own
 * open streams (any tab or device) with who made it, through the real NOTIFY on commit; it never
 * reaches a teammate (even one reading the owner's shared thread), the same member's stream in
 * another team, or a stream that lost its membership. RLS through `withTeam` on every read.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 64 * 1024, maxWorkspaceBytes: 512 * 1024, maxFiles: 100 };
const WAIT_MS = 5_000;
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  // A long periodic recheck: a removal must end the stream through its hint, not the timer.
  await fx.setup([{ timings: { keepaliveMs: 100, revalidateMs: 60_000 } }]);
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } },
  });
});

afterAll(() => fx.teardown());

const sha = (data: string) => createHash("sha256").update(data).digest("hex");

function browserFor(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

interface World {
  readonly team: string;
  readonly alice: Person;
  readonly bob: Person;
}

async function world(): Promise<World> {
  const alice = await fx.person("alice");
  const bob = await fx.person("bob");
  const team = await fx.team(`wc-${randomBytes(3).toString("hex")}`, alice, [bob]);
  return { team, alice, bob };
}

/** A server write (a save, an upload): origin `server`. */
async function serverPut(team: string, who: Person, path: string, content: string) {
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
  return hash;
}

/** The sandbox's push: a blob, then a commit (origin `sandbox`). */
async function agentPush(team: string, who: Person, path: string, content: string) {
  const owner = { teamId: team, userId: who.id };
  const hash = sha(content);
  objects.objects.set(workspaceBlobKey("", owner, hash), Buffer.from(content));
  await withTeam(fx.db, team, async (tx) => {
    await recordBlob(tx, owner, hash, content.length);
    const current = await currentEntry(tx, owner, path);
    const res = await commitChanges(
      tx,
      owner,
      [
        {
          op: "put",
          path,
          base_rev: current && !current.deleted ? current.rev : null,
          sha256: hash,
          size: content.length,
          mtime_ms: Date.now(),
          executable: false,
        },
      ],
      { prefix: "", quota: () => Promise.resolve({ ok: true }), maxRows: 1000 },
    );
    expect(res.results[0]?.status).toBe("applied");
  });
  return hash;
}

function changesUrl(team: string, paths: readonly string[], extra = "") {
  const q = new URLSearchParams({ team });
  for (const p of paths) q.append("path", p);
  return `${PUBLIC_URL}/v1/workspace/changes?${q.toString()}${extra}`;
}

function request(p: Person, url: string) {
  return app.request(url, {
    headers: {
      cookie: [...p.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      "x-forwarded-for": p.browser.ip,
      accept: "text/event-stream",
    },
  });
}

class Changes {
  constructor(readonly reader: SseReader) {}
  /** The next change message (skips keep-alives), or undefined when the stream ended. */
  async next(): Promise<{ event: string; change: WorkspaceFileChange } | undefined> {
    for (;;) {
      const frame = await this.reader.next();
      if (!frame) return undefined;
      if (frame.data !== undefined) {
        return {
          event: frame.event ?? "",
          change: workspaceFileChangeSchema.parse(JSON.parse(frame.data)),
        };
      }
    }
  }
  /** Within the test's wait, or fails. */
  async within(): Promise<{ event: string; change: WorkspaceFileChange } | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no change within the wait")), WAIT_MS);
    });
    try {
      return await Promise.race([this.next(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function open(p: Person, team: string, paths: readonly string[]): Promise<Changes> {
  const res = await request(p, changesUrl(team, paths));
  expect(res.status, await (res.status === 200 ? Promise.resolve("") : res.text())).toBe(200);
  return new Changes(new SseReader(res.body));
}

describe("GET /v1/workspace/changes (KOBE-496)", () => {
  it("catches up by version, then tells the member's other tab who changed the file", async () => {
    const w = await world();
    const v1 = await serverPut(w.team, w.alice, "notes/plan.md", "one\n");
    const tab = await open(w.alice, w.team, ["notes/plan.md", "missing.md"]);
    expect(await tab.within()).toEqual({
      event: "file.state",
      change: expect.objectContaining({
        path: "notes/plan.md",
        sha256: v1,
        actor: { kind: "user", name: "alice" },
      }),
    });
    expect((await tab.within())?.change).toEqual({
      path: "missing.md",
      sha256: null,
      rev: 0,
      actor: null,
      at: null,
    });
    // Another tab saves (the real route): its commit's NOTIFY wakes this stream.
    const other = browserFor(w.alice, w.team);
    const saved = await other.put(
      `/v1/workspace/file?path=notes%2Fplan.md&base_sha256=${v1}`,
      new RawBody("two\n", "text/plain; charset=utf-8"),
    );
    expect(saved.status).toBe(200);
    const changed = await tab.within();
    expect(changed?.event).toBe("file.changed");
    expect(changed?.change).toEqual(
      expect.objectContaining({ sha256: sha("two\n"), actor: { kind: "user", name: "alice" } }),
    );
    // The agent's push of the same file: actor agent.
    const v3 = await agentPush(w.team, w.alice, "notes/plan.md", "three\n");
    expect((await tab.within())?.change).toEqual(
      expect.objectContaining({ sha256: v3, actor: { kind: "agent", name: null } }),
    );
    // A file it does not watch never reaches it; the next one it sees is its own path.
    await agentPush(w.team, w.alice, "elsewhere.md", "x\n");
    const v4 = await agentPush(w.team, w.alice, "notes/plan.md", "four\n");
    expect((await tab.within())?.change).toEqual(expect.objectContaining({ sha256: v4 }));
    // A deletion: no version.
    expect((await other.delete("/v1/workspace/files?path=notes%2Fplan.md")).status).toBe(204);
    expect((await tab.within())?.change).toEqual(
      expect.objectContaining({ path: "notes/plan.md", sha256: null }),
    );
    await tab.reader.cancel();
  });

  it("never reaches a teammate, even one reading the owner's shared thread", async () => {
    const w = await world();
    await serverPut(w.team, w.alice, "a.md", "alice 1\n");
    // Bob reads Alice's thread, shared with the team.
    const run = await fx.run(w.team, w.alice);
    await fx.admin.query(
      `UPDATE threads SET shared_to_team = true
        WHERE id = (SELECT thread_id FROM runs WHERE id = $1)`,
      [run],
    );
    const bobTab = await open(w.bob, w.team, ["a.md"]);
    // Bob has no a.md of his own: never seen, whatever Alice holds at that path.
    expect((await bobTab.within())?.change).toEqual(
      expect.objectContaining({ sha256: null, rev: 0 }),
    );
    await serverPut(w.team, w.alice, "a.md", "alice 2\n");
    await agentPush(w.team, w.alice, "a.md", "alice 3\n");
    // The next thing Bob's stream carries is his own file, not Alice's.
    const bobs = await agentPush(w.team, w.bob, "a.md", "bob 1\n");
    expect((await bobTab.within())?.change).toEqual(
      expect.objectContaining({ path: "a.md", sha256: bobs }),
    );
    await bobTab.reader.cancel();
  });

  it("never crosses teams for the same member", async () => {
    const w = await world();
    await serverPut(w.team, w.alice, "a.md", "team one\n");
    const team2 = await fx.team(`wc2-${randomBytes(3).toString("hex")}`, w.alice);
    const tab2 = await open(w.alice, team2, ["a.md"]);
    expect((await tab2.within())?.change).toEqual(expect.objectContaining({ sha256: null }));
    await agentPush(w.team, w.alice, "a.md", "team one again\n");
    const mine = await serverPut(team2, w.alice, "a.md", "team two\n");
    expect((await tab2.within())?.change).toEqual(expect.objectContaining({ sha256: mine }));
    await tab2.reader.cancel();
    // A stream for the team that is no longer active is refused, as for the frame route.
    const stale = await request(w.alice, changesUrl(w.team, ["a.md"]));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("team_mismatch");
  });

  it("names a project file's change after the member who added it (sync)", async () => {
    const w = await world();
    const slug = `p${randomBytes(3).toString("hex")}`;
    const project = randomUUID();
    await fx.admin.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, $3, $3, $4)`,
      [w.team, project, slug, w.alice.id],
    );
    const content = "project spec\n";
    const hash = sha(content);
    const key = `teams/${w.team}/projects/${randomUUID()}`;
    await fx.admin.query(
      `INSERT INTO project_files
         (team_id, project_id, path, size_bytes, sha256, mime_type, blob_ref, added_by)
       VALUES ($1, $2, 'spec.md', $3, $4, 'text/markdown', $5, $6)`,
      [w.team, project, content.length, hash, key, w.alice.id],
    );
    const path = `projects/${slug}/spec.md`;
    const bobTab = await open(w.bob, w.team, [path]);
    expect((await bobTab.within())?.change.sha256).toBeNull();
    // The mount reconcile writes Bob's read-only copy.
    await withTeam(fx.db, w.team, (tx) =>
      sync.putServerFile(
        tx,
        { teamId: w.team, userId: w.bob.id },
        { path, sha256: hash, size: content.length, blobKey: key },
        "projects",
      ),
    );
    expect((await bobTab.within())?.change).toEqual(
      expect.objectContaining({ path, sha256: hash, actor: { kind: "sync", name: "alice" } }),
    );
    await bobTab.reader.cancel();
  });

  it("ends the stream at once when the member is removed from the team", async () => {
    const w = await world();
    const bobTab = await open(w.bob, w.team, ["a.md"]);
    await bobTab.within();
    const removed = await browserFor(w.alice, w.team).delete(`/v1/team/members/${w.bob.id}`);
    expect(removed.status).toBe(204);
    // Within the wait (5 s), far before the 60 s periodic recheck: the removal's hint did it.
    expect(await bobTab.within()).toBeUndefined();
  });

  it("sends a name the contract accepts, whatever is stored", async () => {
    const w = await world();
    await fx.admin.query(`UPDATE users SET name = $1 WHERE id = $2`, [
      `${"N".repeat(300)}\u0007`,
      w.alice.id,
    ]);
    await serverPut(w.team, w.alice, "n.md", "x\n");
    const tab = await open(w.alice, w.team, ["n.md"]);
    const state = await tab.within();
    expect(state?.change.actor).toEqual({ kind: "user", name: "N".repeat(200) });
    await tab.reader.cancel();
  });

  it("caps workspace streams per user apart from run streams", async () => {
    const w = await world();
    const tabs: Changes[] = [];
    for (let i = 0; i < 8; i += 1) tabs.push(await open(w.alice, w.team, ["a.md"]));
    const ninth = await request(w.alice, changesUrl(w.team, ["a.md"]));
    expect(ninth.status).toBe(429);
    // Run streams still open: their slots are their own.
    const run = await fx.run(w.team, w.alice);
    const runStream = await fx.open(0, w.alice, run);
    expect(runStream.status).toBe(200);
    await runStream.body?.cancel();
    for (const t of tabs) await t.reader.cancel();
  });

  it("refuses malformed requests: no paths, too many, internal paths, other parameters", async () => {
    const w = await world();
    const bad = async (url: string) => (await request(w.alice, url)).status;
    expect(await bad(`${PUBLIC_URL}/v1/workspace/changes?team=${w.team}`)).toBe(400);
    expect(await bad(changesUrl(w.team, [], ""))).toBe(400);
    const many = Array.from({ length: 33 }, (_, i) => `f${i}.md`);
    expect(await bad(changesUrl(w.team, many))).toBe(400);
    expect(await bad(changesUrl(w.team, [".kobe/state.json"]))).toBe(400);
    expect(await bad(changesUrl(w.team, ["../x"]))).toBe(400);
    // No parameter names another member, thread or team: unknown ones are refused.
    expect(await bad(changesUrl(w.team, ["a.md"], `&user=${w.bob.id}`))).toBe(400);
    expect(await bad(changesUrl(w.team, ["a.md"], `&thread=${randomUUID()}`))).toBe(400);
    // Someone outside the team gets nothing at all.
    const carol = await fx.person("carol");
    expect((await request(carol, changesUrl(w.team, ["a.md"]))).status).toBeGreaterThanOrEqual(400);
  });
});
