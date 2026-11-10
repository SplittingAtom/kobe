import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_WORKSPACE_SYNC_NOW,
  workspaceEventSchema,
  type WorkspaceEvent,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { createApp } from "./app.js";
import { notifyTeamWorkspaces } from "./event-stream/access.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { TestBrowser } from "./testing/browser.js";
import { SseReader } from "./testing/sse.js";
import { commitChanges, currentEntry, recordBlob } from "./workspace-sync/store.js";
import {
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * KOBE-599 against a real Postgres and the real sandbox wire: Refresh asks the member's own live
 * sandbox to push (`workspace.sync_now`) and answers after its `workspace.synced`, bounded; an
 * asleep sandbox is woken and the answer is `asleep`; an older agent is never asked. The panel's
 * `GET /v1/workspace/events` moves on the member's own manifest commits and on the team's project
 * changes, never on a teammate's or another team's workspace. RLS through `withTeam` everywhere.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 64 * 1024, maxWorkspaceBytes: 512 * 1024, maxFiles: 100 };
const WAIT_MS = 5_000;
const SYNC_WAIT_MS = 1_500;
const sandboxes: FakeSandbox[] = [];
const woken: string[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await fx.setup([{ timings: { keepaliveMs: 100, revalidateMs: 60_000 } }], () => ({
    sandboxWire: {
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: {
      sync,
      syncWaitMs: SYNC_WAIT_MS,
      waker: {
        wake: (target) => {
          woken.push(target.userId);
          return Promise.resolve();
        },
      },
    },
  });
  listener = await sandboxListener(fx.replica(0).deps, auth);
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

const sha = (data: string) => createHash("sha256").update(data).digest("hex");

function browserFor(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

async function world() {
  const alice = await fx.person("alice");
  const bob = await fx.person("bob");
  const team = await fx.team(`we-${randomBytes(3).toString("hex")}`, alice, [bob]);
  return { team, alice, bob };
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
}

/** A connected sandbox of `who` in `team`, announcing `capabilities`. */
async function sandboxOf(team: string, who: Person, capabilities: readonly string[]) {
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: who.id });
  const sb = await FakeSandbox.connect(listener.url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId, [], undefined, capabilities);
  await sb.ready();
  return sb;
}

async function refresh(p: Person, team: string) {
  const started = Date.now();
  const res = await browserFor(p, team).post("/v1/workspace/sync", {});
  return { status: res.status, body: res.json as { status: string }, ms: Date.now() - started };
}

async function listNames(p: Person, team: string, folder = ""): Promise<string[]> {
  const res = await browserFor(p, team).get(
    `/v1/workspace/files?path=${encodeURIComponent(folder)}`,
  );
  if (res.status === 404) return [];
  expect(res.status).toBe(200);
  return (res.json as { entries: { name: string }[] }).entries.map((e) => e.name);
}

describe("POST /v1/workspace/sync (KOBE-599)", () => {
  it("asleep: answers at once and wakes the sandbox", async () => {
    const w = await world();
    const res = await refresh(w.alice, w.team);
    expect(res).toMatchObject({ status: 200, body: { status: "asleep" } });
    expect(woken).toContain(w.alice.id);
  });

  it("running: the sandbox pushes on request and the listing then shows the file", async () => {
    const w = await world();
    const sb = await sandboxOf(w.team, w.alice, [CAPABILITY_WORKSPACE_SYNC_NOW]);
    sb.respond = (frame) => {
      if (frame.type !== "workspace.sync_now") return undefined;
      void agentPush(w.team, w.alice, "fresh.txt", "written seconds ago").then(() =>
        sb.send({ v: 1, type: "workspace.synced", request_id: frame.request_id, ok: true }),
      );
      return null;
    };
    expect(await listNames(w.alice, w.team)).not.toContain("fresh.txt");
    const res = await refresh(w.alice, w.team);
    expect(res).toMatchObject({ status: 200, body: { status: "synced" } });
    expect(await listNames(w.alice, w.team)).toContain("fresh.txt");
    expect(sb.frames("workspace.sync_now")).toHaveLength(1);
  });

  it("an older agent is never asked: not_synced at once; a silent one times out", async () => {
    const w = await world();
    const old = await sandboxOf(w.team, w.alice, []);
    const res = await refresh(w.alice, w.team);
    expect(res.body.status).toBe("not_synced");
    expect(res.ms).toBeLessThan(SYNC_WAIT_MS);
    expect(old.frames("workspace.sync_now")).toHaveLength(0);
    old.close();
    await old.waitClosed();

    const w2 = await world();
    const silentSb = await sandboxOf(w2.team, w2.alice, [CAPABILITY_WORKSPACE_SYNC_NOW]);
    silentSb.respond = (frame) => (frame.type === "workspace.sync_now" ? null : undefined);
    const late = await refresh(w2.alice, w2.team);
    expect(late.body.status).toBe("timeout");
    expect(late.ms).toBeGreaterThanOrEqual(SYNC_WAIT_MS - 50);
  });

  it("an answer from another member's sandbox is dropped", async () => {
    const w = await world();
    const mine = await sandboxOf(w.team, w.alice, [CAPABILITY_WORKSPACE_SYNC_NOW]);
    const theirs = await sandboxOf(w.team, w.bob, [CAPABILITY_WORKSPACE_SYNC_NOW]);
    mine.respond = (frame) => {
      if (frame.type !== "workspace.sync_now") return undefined;
      // Bob's sandbox claims to answer Alice's request: not asked on its connection, dropped.
      theirs.send({ v: 1, type: "workspace.synced", request_id: frame.request_id, ok: true });
      return null;
    };
    const res = await refresh(w.alice, w.team);
    expect(res.body.status).toBe("timeout");
  });
});

class Events {
  /** A read `within` gave up on: the next call reuses it, so a timed-out wait never loses a frame. */
  #pending: Promise<{ event: string; data: WorkspaceEvent } | undefined> | undefined;
  constructor(readonly reader: SseReader) {}
  async next(): Promise<{ event: string; data: WorkspaceEvent } | undefined> {
    for (;;) {
      const frame = await this.reader.next();
      if (!frame) return undefined;
      if (frame.data !== undefined) {
        return {
          event: frame.event ?? "",
          data: workspaceEventSchema.parse(JSON.parse(frame.data)),
        };
      }
    }
  }
  async within(ms = WAIT_MS) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"none">((resolve) => {
      timer = setTimeout(() => resolve("none"), ms);
    });
    const read = this.#pending ?? this.next();
    this.#pending = read;
    try {
      const got = await Promise.race([read, timeout]);
      if (got !== "none") this.#pending = undefined;
      return got;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function openEvents(p: Person, team: string, query = `team=${team}`) {
  return app.request(`${PUBLIC_URL}/v1/workspace/events?${query}`, {
    headers: {
      cookie: [...p.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      "x-forwarded-for": p.browser.ip,
      accept: "text/event-stream",
    },
  });
}

async function events(p: Person, team: string): Promise<Events> {
  const res = await openEvents(p, team);
  expect(res.status, res.status === 200 ? "" : await res.text()).toBe(200);
  return new Events(new SseReader(res.body));
}

describe("GET /v1/workspace/events (KOBE-599)", () => {
  it("moves on the member's own pushes and uploads, never on a teammate's or another team's", async () => {
    const w = await world();
    const other = await fx.team(`wo-${randomBytes(3).toString("hex")}`, w.alice);
    await fx.activate(w.alice, w.team);
    const panel = await events(w.alice, w.team);
    const first = await panel.within();
    expect(first).toMatchObject({ event: "workspace.state", data: { files_rev: 0 } });
    if (first === "none" || first === undefined) throw new Error("no state");

    // A teammate's push and the member's own workspace in another team: nothing here.
    await agentPush(w.team, w.bob, "bob.txt", "b");
    await agentPush(other, w.alice, "elsewhere.txt", "e");
    expect(await panel.within(1_000)).toBe("none");

    // The member's agent pushes: changed.
    await agentPush(w.team, w.alice, "mine.txt", "m");
    const pushed = await panel.within();
    expect(pushed).toMatchObject({ event: "workspace.changed" });
    if (pushed === "none" || pushed === undefined) throw new Error("no change");
    expect(pushed.data.files_rev).toBeGreaterThan(first.data.files_rev);
    expect(pushed.data.projects_rev).toBe(first.data.projects_rev);
    await panel.reader.cancel();
  });

  it("moves for every member when the team's projects change (a teammate's commit)", async () => {
    const w = await world();
    const alicePanel = await events(w.alice, w.team);
    const bobPanel = await events(w.bob, w.team);
    const a0 = await alicePanel.within();
    const b0 = await bobPanel.within();
    if (a0 === "none" || a0 === undefined || b0 === "none" || b0 === undefined) {
      throw new Error("no state");
    }
    await fx.admin.query(
      `INSERT INTO projects (team_id, slug, name, created_by) VALUES ($1, 'plan', 'Plan', $2)`,
      [w.team, w.bob.id],
    );
    await withTeam(fx.db, w.team, (tx) => notifyTeamWorkspaces(tx, w.team));
    for (const [panel, before] of [
      [alicePanel, a0],
      [bobPanel, b0],
    ] as const) {
      const moved = await panel.within();
      expect(moved).toMatchObject({ event: "workspace.changed" });
      if (moved === "none" || moved === undefined) throw new Error("no change");
      expect(moved.data.projects_rev).not.toBe(before.data.projects_rev);
      expect(moved.data.files_rev).toBe(before.data.files_rev);
      await panel.reader.cancel();
    }
  });

  it("refuses another team than the active one and a malformed query", async () => {
    const w = await world();
    const other = await fx.team(`wx-${randomBytes(3).toString("hex")}`, w.bob);
    await fx.activate(w.bob, w.team);
    expect((await openEvents(w.alice, other)).status).toBe(409);
    expect((await openEvents(w.alice, w.team, "team=nope")).status).toBe(400);
    expect((await openEvents(w.alice, w.team, `team=${w.team}&path=x`)).status).toBe(400);
  });
});
